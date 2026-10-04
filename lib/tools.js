/**
 * dsh-memu 注册给 DSH agent 的三个原生工具：
 * - memu_retrieve        —— inject seam：回答前检索长期记忆；
 * - memu_bridge_prepare  —— record seam：把新会话转录切成 memU 挖掘 job；
 * - memu_bridge_commit   —— record seam：全部 job 成功后提交。
 *
 * 三者都是对 `<command...> <verb>` 的一次子进程调用（走 ctx 的 subprocess 服务，
 * 不经过 shell），失败即抛错，由框架映射成工具失败结果。
 *
 * @module dsh-memu/tools
 */
import { truncateText } from "./project.js";

/** 单次调用的采集上限（字符数）。 */
const OUTPUT_MAX_CHARS = 4 * 1024 * 1024;
const ERROR_MAX_CHARS = 256 * 1024;

/** 取进程的 subprocess 服务（缺省时给出明确错误）。 */
function subprocessOf(ctx) {
	const service = typeof ctx?.get === "function" ? ctx.get("subprocess") : ctx?.subprocess;
	if (service === undefined || service === null) {
		throw new Error("dsh-memu: 无法获取 subprocess 服务，插件无法调用 memU");
	}
	return service;
}

/** 把管道流抽干成字符串（超出上限即截断）；不是流就返回空串。 */
function drainStream(stream, maxChars) {
	if (stream === undefined || stream === null || typeof stream.on !== "function") return Promise.resolve("");
	return new Promise((resolve) => {
		let text = "";
		let truncated = false;
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve(truncated ? `${text}\n…[输出超过 ${maxChars} 字符，已截断]` : text);
		};
		if (typeof stream.setEncoding === "function") stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			if (truncated) return;
			text += typeof chunk === "string" ? chunk : String(chunk);
			if (text.length > maxChars) {
				truncated = true;
				text = text.slice(0, maxChars);
			}
		});
		stream.once("end", finish);
		stream.once("close", finish);
		stream.once("error", finish);
	});
}

/** 兜底读一次 collect 快照（句柄若没暴露 pipe 流，输出可能只留在这里）。 */
function readCollectedOnce(handle, name) {
	const reader = handle?.collected?.[name];
	if (reader === undefined || reader === null || typeof reader.readFrom !== "function") return "";
	try {
		const chunk = reader.readFrom(0);
		return chunk !== null && typeof chunk === "object" && typeof chunk.text === "string" ? chunk.text : "";
	} catch {
		return "";
	}
}

/** 一个字节都没吐出来时，给出足以定位宿主接线问题的诊断。 */
function silenceNote(handle) {
	const kind = (stream) => (stream === undefined || stream === null ? "none" : typeof stream.on === "function" ? "stream" : typeof stream);
	const collected = handle?.collected === undefined || handle?.collected === null ? "none" : Object.keys(handle.collected).join(",") || "empty";
	return `无输出（stdout=${kind(handle?.stdout)} stderr=${kind(handle?.stderr)} collected=${collected}）`;
}

/**
 * 运行一次 memU 命令。
 *
 * 用 pipe 模式而不是 collect 模式：句柄的 `stdout`/`stderr` 只在 pipe 模式下暴露，
 * 而 `handle.collected` 的 `readFrom` 要靠宿主把 runner 的输出真正 push 进来——
 * 实测装机后 collect 读数器始终为空，于是「有输出」被误报成「无输出」。
 * 这里走标准 Node 流：spawn 后立刻挂读取器（晚一步子进程会写满管道而阻塞），
 * 等 done 落地、流收尾后再取文本；collect 快照只作为兜底。
 *
 * @param ctx Cordis 上下文。
 * @param config 已归一化的插件配置。
 * @param args memU 子命令及其参数。
 * @param signal 取消信号。
 * @returns `{ stdout, stderr, exitCode, silence }`。
 */
async function runMemu(ctx, config, args, signal) {
	const subprocess = subprocessOf(ctx);
	const argv = [...config.command, ...args];
	let executable = argv[0];
	try {
		executable = await subprocess.resolveExecutable(argv[0], undefined, signal);
	} catch {
		// 解析失败就交给 spawn 去报错，保留原始错误信息
	}
	const handle = subprocess.spawn({
		argv: [executable, ...argv.slice(1)],
		cwd: process.cwd(),
		stdio: {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe"
		},
		graceMs: 2000,
		signal
	});
	// 必须立刻挂上读取器：晚一步子进程就可能写满管道缓冲区而卡住
	const stdoutTask = drainStream(handle.stdout, OUTPUT_MAX_CHARS);
	const stderrTask = drainStream(handle.stderr, ERROR_MAX_CHARS);
	let spawnError = null;
	let outcome = null;
	try {
		outcome = await handle.done;
	} catch (error) {
		spawnError = error;
	}
	let stdout = await stdoutTask;
	let stderr = await stderrTask;
	if (stdout.length === 0 && stderr.length === 0) {
		stdout = readCollectedOnce(handle, "stdout");
		stderr = readCollectedOnce(handle, "stderr");
	}
	if (spawnError !== null) {
		const text = String(spawnError?.message ?? spawnError);
		stderr = stderr.length === 0 ? text : `${stderr}\n${text}`;
	}
	const exitCode = Number.isFinite(outcome?.exitCode) ? Number(outcome.exitCode) : 1;
	return { stdout, stderr, exitCode, silence: silenceNote(handle) };
}

/** 失败信息里的摘要行。 */
function tail(text, limit = 2000) {
	const value = typeof text === "string" ? text.trim() : "";
	if (value.length <= limit) return value;
	return `…${value.slice(value.length - limit)}`;
}

/** 压成一行，便于在工具结果里紧凑展示。 */
function oneLine(value, limit = 400) {
	if (value === null || value === undefined) return "";
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return truncateText(String(text).replace(/\s+/g, " ").trim(), limit);
}

/** 把 memU retrieve 的 JSON 结果渲染成紧凑文本。 */
export function formatRetrieve(value) {
	const textBlock = (text) => [{ type: "text", text }];
	if (value === null || typeof value !== "object") return textBlock(truncateText(String(value), 4000));
	const lines = [];
	const sections = [
		["segments", Array.isArray(value.segments) ? value.segments : [], (item) => `[${item.source_file ?? "?"}] ${oneLine(item.text ?? item.content)}`],
		["files", Array.isArray(value.files) ? value.files : [], (item) => `[${item.source_file ?? item.name ?? "?"}]${item.path ? ` path=${item.path}` : ""} ${oneLine(item.summary ?? item.content)}`],
		["resources", Array.isArray(value.resources) ? value.resources : [], (item) => `${item.path ? `path=${item.path}` : ""} ${oneLine(item.summary ?? item.title ?? "")}`]
	];
	for (const [label, items, render] of sections) {
		if (items.length === 0) continue;
		lines.push(`${label} (${items.length}):`);
		items.forEach((item, index) => {
			lines.push(`  ${index + 1}. ${render(item ?? {})}`);
		});
	}
	if (lines.length === 0) {
		return textBlock(`memU 未返回任何记忆。原始结果：\n${truncateText(JSON.stringify(value, null, 2), 4000)}`);
	}
	return textBlock(lines.join("\n"));
}

/** 构造 memu_retrieve 工具定义。 */
function retrieveTool(ctx, config) {
	return {
		name: "memu_retrieve",
		description:
			"检索 memU 的长期记忆：segments（最切题的片段，source_file 指出它属于哪份文档）、files（综合文档）、resources（本机相关文件）。"
			+ "需要用户的既往偏好、历史决定或项目约定时调用；未配置 embedding 时会失败，此时照常回答即可（fail-open）。",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "检索词，可以是自然语言；用关键词效果更好" }
			},
			required: ["query"],
			additionalProperties: false
		},
		output: {
			schema: { type: "object", description: "memU retrieve 的 JSON 结果（segments / files / resources）", additionalProperties: true },
			render(_args, value) {
				return formatRetrieve(value);
			}
		},
		timeoutMs: 60000,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const query = typeof args?.query === "string" ? args.query.trim() : "";
			if (query.length === 0) throw new Error("memu_retrieve: query 不能为空");
			const result = await runMemu(ctx, config, ["retrieve", query], exec?.signal);
			if (result.exitCode !== 0) {
				throw new Error(`memu_retrieve 失败（exit ${result.exitCode}）：${tail(result.stderr) || tail(result.stdout) || result.silence}`);
			}
			try {
				return JSON.parse(result.stdout);
			} catch {
				return { raw: result.stdout };
			}
		}
	};
}

/** 构造 memu_bridge_prepare 工具定义。 */
function prepareTool(ctx, config) {
	return {
		name: "memu_bridge_prepare",
		description:
			"运行 memU 的 prepare：把 DSH 尚未挖掘的新会话转录切成一串串行 job，并返回挖掘任务说明。"
			+ "调用成功后你必须自己按顺序执行全部 job（一个会话串行做完），全部成功后才调用 memu_bridge_commit；不要跳过、重排或并行。",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		output: {
			schema: { type: "object", description: "prepare 的输出与挖掘任务说明", additionalProperties: true },
			render(_args, value) {
				return [{ type: "text", text: `${value?.summary ?? ""}\n\n${value?.task_doc ?? ""}`.trim() }];
			}
		},
		timeoutMs: 120000,
		isConcurrencySafe: () => false,
		async execute(_args, exec) {
			const result = await runMemu(ctx, config, ["prepare"], exec?.signal);
			if (result.exitCode !== 0) {
				throw new Error(`memu_bridge_prepare 失败（exit ${result.exitCode}）：${tail(result.stderr) || tail(result.stdout) || result.silence}`);
			}
			const summary = result.stdout.trim();
			let taskDoc = "";
			try {
				const doc = await runMemu(ctx, config, ["docs", "task"], exec?.signal);
				if (doc.exitCode === 0) taskDoc = doc.stdout.trim();
			} catch {
				// 任务说明取不到不影响 prepare 的成功
			}
			return { summary, task_doc: taskDoc };
		}
	};
}

/** 构造 memu_bridge_commit 工具定义。 */
function commitTool(ctx, config) {
	return {
		name: "memu_bridge_commit",
		description: "运行 memU 的 commit：把所有 job 产出的记忆与 skill 提交进记忆库。只有全部 job 成功后才调用一次；提交失败时直接重试本工具，不要重跑 prepare。",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		output: {
			schema: { type: "object", description: "commit 的输出", additionalProperties: true },
			render(_args, value) {
				return [{ type: "text", text: String(value?.summary ?? "").trim() || "commit 完成" }];
			}
		},
		timeoutMs: 300000,
		isConcurrencySafe: () => false,
		async execute(_args, exec) {
			const result = await runMemu(ctx, config, ["commit"], exec?.signal);
			if (result.exitCode !== 0) {
				throw new Error(`memu_bridge_commit 失败（exit ${result.exitCode}）：${tail(result.stderr) || tail(result.stdout) || result.silence}`);
			}
			return { summary: result.stdout.trim() };
		}
	};
}

/**
 * 构造全部工具定义。
 * @param ctx Cordis 上下文（宿主平面）。
 * @param config 已归一化的插件配置。
 * @returns 工具定义数组。
 */
export function createTools(ctx, config) {
	return [retrieveTool(ctx, config), prepareTool(ctx, config), commitTool(ctx, config)];
}
