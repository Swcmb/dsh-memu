/**
 * dsh-memu 的转录导出器：把 DSH 会话事件按会话追加写入 memU 可读的 JSONL。
 *
 * 布局：<transcriptsDir>/<encoded-cwd>/<session-id>.jsonl
 * （目录形状刻意与 $DSH_HOME/sessions 保持一致，便于人工对照；memU 侧是整根
 *   rglob("*.jsonl")，所以布局本身不承重。）
 *
 * 追加式 + 可续：文件每行自带 seq；重新跟踪一个会话时尾读最后一行的 seq，
 * 用 session.snapshotEvents() 补发它之后的事件。因此不需要旁路状态文件，插件
 * 重载后也不会重复追加。
 *
 * 全链路 fail-open：任何失败只记 warning，绝不向事件路径抛异常。
 *
 * @module dsh-memu/exporter
 */
import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createProjection, DEFAULT_MAX_FIELD_CHARS } from "./project.js";

/** 尾读窗口大小（字节）：足以容纳最后一条记录即可。 */
const TAIL_WINDOW_BYTES = 64 * 1024;

/**
 * 复刻 DSH 自己的 cwd 编码形态：只把分隔符与冒号折成 `-`，点号保留
 * （`D:\memU` → `--D-memU--`，`C:\Users\Swcmb\.dsh\x` → `--C-Users-Swcmb-.dsh-x--`）。
 * @param cwd 会话的工作目录。
 * @returns 编码后的目录名。
 */
export function encodeCwd(cwd) {
	const text = typeof cwd === "string" ? cwd.trim() : "";
	if (text.length === 0) return "--unknown--";
	return `--${text.replace(/[\\/:\s]+/g, "-")}--`;
}

/** 会话 id；取不到就返回空串（调用方据此跳过）。 */
function sessionIdOf(session) {
	const id = session?.id ?? session?.header?.id;
	return typeof id === "string" ? id : "";
}

/**
 * 尾读文件里最后一条可解析记录的 seq。
 * @param file 目标文件。
 * @returns 最后一个 seq；文件不存在或没有 seq 时返回 undefined。
 */
async function readLastSeq(file) {
	let handle;
	try {
		handle = await open(file, "r");
		const stat = await handle.stat();
		if (stat.size === 0) return undefined;
		const window = Math.min(stat.size, TAIL_WINDOW_BYTES);
		const buffer = Buffer.alloc(window);
		await handle.read(buffer, 0, window, stat.size - window);
		let lines = buffer.toString("utf8").split("\n");
		// 窗口没覆盖整个文件时，首行可能被切断，丢掉它。
		if (stat.size > window) lines = lines.slice(1);
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const line = lines[index].trim();
			if (line.length === 0 || !line.endsWith("}")) continue;
			try {
				const seq = Number(JSON.parse(line)?.seq);
				if (Number.isFinite(seq)) return seq;
			} catch {
				// 这一行坏了就继续往前找
			}
		}
		return undefined;
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => {});
	}
}

/**
 * 创建一个导出器。
 *
 * @param options.dir 转录根目录（绝对路径）。
 * @param options.maxFieldChars 单条字段的截断上限。
 * @param options.logger 可选 logger（缺省时静默降级到 console.warn）。
 * @returns {{track: (session: unknown) => Promise<void>, append: (session: unknown, event: unknown) => void, forget: (id: string) => void, flush: () => Promise<void>}}
 */
export function createExporter(options = {}) {
	const root = options.dir;
	const maxFieldChars = Number.isFinite(options.maxFieldChars) ? Number(options.maxFieldChars) : DEFAULT_MAX_FIELD_CHARS;
	const logger = options.logger;
	/** sessionId → 导出状态。 */
	const states = new Map();
	/** 尚未结算的实时追加任务，供 flush 等待。 */
	const inflight = new Set();

	/** 统一的降级告警口。 */
	function warn(message, error) {
		const text = `dsh-memu: ${message}${error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`}`;
		if (typeof logger?.warn === "function") logger.warn(text);
		else console.warn(text);
	}

	/** 建立（幂等的）会话导出状态，并完成一次补录。 */
	async function track(session) {
		if (typeof root !== "string" || root.length === 0) return;
		const id = sessionIdOf(session);
		if (id.length === 0) return;
		let state = states.get(id);
		if (state === undefined) {
			state = {
				file: join(root, encodeCwd(session?.header?.cwd), `${id}.jsonl`),
				projection: createProjection({ maxFieldChars }),
				queue: Promise.resolve(),
				/** 补录窗口的上界：seq 不超过它的事件已由补录写入，实时回调要跳过。 */
				horizon: Number.NaN,
				ready: undefined
			};
			states.set(id, state);
			state.ready = catchUp(session, state);
		}
		await state.ready;
	}

	/** 补录：尾读已导出的 seq，重放它之后的事件。 */
	async function catchUp(session, state) {
		const lastSeq = await readLastSeq(state.file);
		const horizon = Number(session?.seq);
		const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
		const lines = [];
		for (const event of events) {
			const seq = Number(event?.seq);
			// 已有导出时只补 seq 更大的事件；首次导出（lastSeq 为空）则全量重放。
			if (Number.isFinite(lastSeq) && (!Number.isFinite(seq) || seq <= lastSeq)) continue;
			const record = state.projection.project(event);
			if (record !== null) lines.push(JSON.stringify(record));
		}
		state.horizon = Number.isFinite(horizon) ? horizon : Number.NaN;
		if (lines.length > 0) await enqueue(state, lines);
	}

	/** 把若干行排进该会话的串行写队列，保证不交错。 */
	function enqueue(state, lines) {
		state.queue = state.queue.then(async () => {
			await mkdir(dirname(state.file), { recursive: true });
			await appendFile(state.file, `${lines.join("\n")}\n`, "utf8");
		});
		state.queue = state.queue.catch((error) => {
			warn(`failed to append transcript ${state.file}`, error);
		});
		return state.queue;
	}

	/** 把一条实时事件投影并追加；未跟踪的会话直接忽略。 */
	function append(session, event) {
		const state = states.get(sessionIdOf(session));
		if (state === undefined) return;
		const task = state.ready
			.then(() => {
				const seq = Number(event?.seq);
				if (Number.isFinite(state.horizon) && Number.isFinite(seq) && seq <= state.horizon) return;
				const record = state.projection.project(event);
				if (record === null) return;
				return enqueue(state, [JSON.stringify(record)]);
			})
			.catch((error) => {
				warn("failed to project session event", error);
			});
		inflight.add(task);
		task.finally(() => inflight.delete(task));
	}

	/** 忘记一个会话（不再跟踪）。 */
	function forget(id) {
		if (typeof id === "string") states.delete(id);
	}

	/** 等待所有会话的写队列落盘（含等待期间新产生的追加任务）。 */
	async function flush() {
		while (inflight.size > 0) {
			await Promise.all([...inflight]);
		}
		await Promise.all([...states.values()].map((state) => state.queue));
	}

	return { track, append, forget, flush };
}
