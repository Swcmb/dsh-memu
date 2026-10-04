/**
 * dsh-memu —— 把 memU 长期记忆接进 DeepSeek Harness 的 Cordis 宿主插件。
 *
 * 三块职责：
 * 1. inject seam：注册常驻指令（系统提示词段落），让 agent 回答前先取记忆；
 * 2. inject seam：注册三个原生工具（retrieve / bridge prepare / bridge commit）；
 * 3. record seam：订阅 session/event，把会话事件投影成 memU 可挖的 JSONL 转录。
 *
 * 本插件**只 import Node 内置模块**：这样用 `link:` 装进 profile 时不需要在插件目录
 * 里再装一份 node_modules（Node 解析 bare specifier 会沿真实路径向上找，link 的包
 * 很容易解析失败）。DSH_HOME 也自己读环境变量，不依赖 @deepseek-ai/dsh-home-paths。
 *
 * @module dsh-memu
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createExporter } from "./exporter.js";
import { createTools } from "./tools.js";

/** Cordis provider 名（与 package.json 的 name、patch 层的 name 一致）。 */
export const name = "dsh-memu";

/** 默认配置。 */
const DEFAULTS = Object.freeze({
	command: ["memu-dsh"],
	transcriptsDir: "",
	exportEnabled: true,
	toolEnabled: true,
	instructionEnabled: true,
	maxFieldChars: 8000,
	sectionOrder: 900
});

/** 常驻指令文本：语义对齐 memU 自己的 instruction 模板（files/segments/resources 三层）。 */
export const INSTRUCTION_TEXT = [
	"## memU —— 回答前先取记忆",
	"",
	"回答用户之前，只要问题可能依赖用户的既往偏好、历史决定或项目约定，就先调用 `memu_retrieve` 工具（把问题改写成关键词，query 越具体越好）。",
	"",
	"结果分三层：",
	"- `segments`：最窄、最切题的片段，每条在 `source_file` 里指出它属于哪份文档；",
	"- `files`：综合文档，用 segment 的 `source_file` 去这里找全文；给了 `path` 时，只在需要摘要没覆盖的细节时才打开；",
	"- `resources`：与本机相关的文件，`path` 加摘要。",
	"",
	"先从片段和摘要作答，不要反射式地把所有文件都读一遍。",
	"",
	"`memu_retrieve` 失败时（例如尚未配置 embedding 供应商），就按没有记忆的情况正常回答：不要重试，也不要向用户报错。",
	"",
	"需要把本次会话沉淀成长期记忆时：先调用 `memu_bridge_prepare`，再按它返回的任务说明**串行**执行全部 job，全部成功后才调用一次 `memu_bridge_commit`。"
].join("\n");

/** 启动横幅：宿主日志里能直接确认插件已接线（排查"装了但没生效"时第一眼就看这里）。 */
function note(ctx, message) {
	const text = `dsh-memu: ${message}`;
	if (typeof ctx?.logger?.info === "function") ctx.logger.info(text);
	else console.info(text);
}

/** 统一的降级告警口。 */
function warn(ctx, message, error) {
	const text = `dsh-memu: ${message}${error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`}`;
	if (typeof ctx?.logger?.warn === "function") ctx.logger.warn(text);
	else console.warn(text);
}

/**
 * 服务就绪后执行一次。
 *
 * Cordis 的插件是并发加载的：兄弟插件（例如 `@deepseek-ai/dsh-tools`）注册服务可能发生在
 * 本插件 apply 之后，此刻 `ctx.get(name)` 仍是 undefined。注册工具/指令必须真的拿到服务对象，
 * 所以这里等服务出现再接线（`internal/service` 事件 + 轮询双保险），超时才降级告警。
 */
function whenService(ctx, serviceName, setup, timeoutMs = 30000) {
	const available = () => (typeof ctx.get === "function" ? ctx.get(serviceName) : undefined);
	const now = available();
	if (now !== undefined) {
		setup(now);
		return;
	}
	let settled = false;
	let timer;
	let poll;
	let off;
	const finish = (value) => {
		if (settled) return;
		settled = true;
		if (timer !== undefined) clearTimeout(timer);
		if (poll !== undefined) clearInterval(poll);
		if (typeof off === "function") off();
		setup(value);
	};
	try {
		off = ctx.on("internal/service", (service, value) => {
			if (service !== serviceName) return;
			if (value !== undefined) finish(value);
		});
	} catch {
		// 宿主不提供该事件时由轮询兜底
	}
	poll = setInterval(() => {
		const value = available();
		if (value !== undefined) finish(value);
	}, 200);
	if (typeof poll.unref === "function") poll.unref();
	timer = setTimeout(() => {
		if (settled) return;
		settled = true;
		if (poll !== undefined) clearInterval(poll);
		if (typeof off === "function") off();
		warn(ctx, `${serviceName} 服务在 ${timeoutMs}ms 内未就绪，跳过接线`);
	}, timeoutMs);
	if (typeof timer.unref === "function") timer.unref();
}

/** 归一化插件配置；未提供或用错类型时回落到默认值。 */
export function resolveConfig(config = {}) {
	const raw = config !== null && typeof config === "object" ? config : {};
	const command = Array.isArray(raw.command) && raw.command.length > 0 ? raw.command.map(String) : [...DEFAULTS.command];
	const dshHome = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.length > 0
		? process.env.DSH_HOME
		: join(homedir(), ".dsh");
	return {
		command,
		transcriptsDir: typeof raw.transcriptsDir === "string" && raw.transcriptsDir.length > 0
			? raw.transcriptsDir
			: join(dshHome, "memu", "transcripts"),
		exportEnabled: raw.exportEnabled ?? DEFAULTS.exportEnabled,
		toolEnabled: raw.toolEnabled ?? DEFAULTS.toolEnabled,
		instructionEnabled: raw.instructionEnabled ?? DEFAULTS.instructionEnabled,
		maxFieldChars: Number.isFinite(raw.maxFieldChars) ? Number(raw.maxFieldChars) : DEFAULTS.maxFieldChars,
		sectionOrder: Number.isFinite(raw.sectionOrder) ? Number(raw.sectionOrder) : DEFAULTS.sectionOrder
	};
}

/** 注册常驻指令段落（等服务就绪）。 */
function wireInstruction(ctx, resolved) {
	whenService(ctx, "systemPrompt", (systemPrompt) => {
		if (typeof systemPrompt?.section !== "function") {
			warn(ctx, "systemPrompt 服务没有 section()，跳过常驻指令");
			return;
		}
		try {
			systemPrompt.section({ name: "memu-memory", order: resolved.sectionOrder, text: INSTRUCTION_TEXT });
		} catch (error) {
			// 同一进程里插件被加载两次（例如 bundle 层与 patch overlay 各加载一份）时这个段落名已被占用。
			// 这里必须降级成告警：抛出会让插件的 apply 失败，进而把整棵插件树的加载拖垮。
			warn(ctx, "注册常驻指令失败（同名段落可能已存在）", error);
		}
	});
}

/** 注册三个工具（等服务就绪：服务未就绪时直接返回，会让工具在宿主里静默失踪）。 */
function wireTools(ctx, resolved) {
	whenService(ctx, "tools", (tools) => {
		if (typeof tools?.register !== "function") {
			warn(ctx, "tools 服务没有 register()，跳过工具注册");
			return;
		}
		for (const definition of createTools(ctx, resolved)) {
			try {
				tools.register(definition);
			} catch (error) {
				warn(ctx, `注册工具 ${definition.name} 失败`, error);
			}
		}
	});
}

/** 接线转录导出：订阅会话事件（不依赖服务）+ 服务就绪后补录已有会话。 */
function wireExport(ctx, resolved) {
	const exporter = createExporter({ dir: resolved.transcriptsDir, maxFieldChars: resolved.maxFieldChars, logger: ctx.logger });

	// 插件晚加载/热加载时，已有会话也要补录
	whenService(ctx, "sessions", (sessions) => {
		try {
			for (const session of sessions.list() ?? []) {
				exporter.track(session).catch((error) => warn(ctx, "跟踪已有会话失败", error));
			}
		} catch (error) {
			warn(ctx, "枚举已有会话失败", error);
		}
	});

	ctx.on("session/created", (payload) => {
		const session = payload?.session ?? payload;
		exporter.track(session).catch((error) => warn(ctx, "跟踪新会话失败", error));
	});
	ctx.on("session/event", (session, event) => {
		const target = session ?? event?.session;
		const targetEvent = event ?? session?.event;
		if (target === undefined || targetEvent === undefined) return;
		exporter.append(target, targetEvent);
	});
	ctx.on("session/disposed", (payload) => {
		const session = payload?.session ?? payload;
		exporter.forget(session?.id);
	});
}

/**
 * 注册插件。
 * @param ctx Cordis 上下文（宿主平面）。
 * @param config 插件配置（可在 profile 的 cordis.patch.yml 里按 id 定向覆盖）。
 */
export function apply(ctx, config = {}) {
	const resolved = resolveConfig(config);
	if (resolved.instructionEnabled) wireInstruction(ctx, resolved);
	if (resolved.toolEnabled) wireTools(ctx, resolved);
	if (resolved.exportEnabled) wireExport(ctx, resolved);
	note(
		ctx,
		`已加载（指令=${resolved.instructionEnabled ? "开" : "关"}，工具=${resolved.toolEnabled ? "开" : "关"}，`
		+ `转录导出=${resolved.exportEnabled ? resolved.transcriptsDir : "关"}，命令=${resolved.command.join(" ")}）`
	);
}
