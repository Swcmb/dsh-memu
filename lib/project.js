/**
 * dsh-memu 的会话投影：把 DSH 的 session event 收敛成 memU 可挖的规范记录。
 *
 * 设计要点：
 * - 纯投影 + 一点小状态（callId → 工具名），零 IO，便于单测；
 * - 只认识三类记录：message / tool_call / tool_result，其余事件整条丢弃
 *   （尤其是 system/message、request/header、session-log-* 等噪音，它们含完整
 *   系统提示词与工具目录，绝不能进记忆）；
 * - reasoning 块不进记忆，与 memU canonical schema（只有 message/tool_call/
 *   tool_result）保持一致。
 *
 * @module dsh-memu/project
 */

/** 单条字段的默认截断上限（字符）。 */
export const DEFAULT_MAX_FIELD_CHARS = 8000;

/** 本插件会产出的记录类型。 */
export const RECORD_TYPES = Object.freeze(["message", "tool_call", "tool_result"]);

/**
 * 截断长文本，并在尾部标注被丢弃的长度。
 * @param value 待截断的文本。
 * @param max 上限（字符）。
 * @returns 截断后的文本。
 */
export function truncateText(value, max = DEFAULT_MAX_FIELD_CHARS) {
	if (typeof value !== "string" || value.length <= max) return value;
	return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`;
}

/** 取出 content 里所有 text 块的文本，用空行拼接。 */
function textOf(content) {
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n\n");
}

/** 工具调用的 arguments：优先解析 JSON 字符串，失败就原样保留。 */
function parseArguments(value) {
	if (typeof value !== "string") return value === undefined || value === null ? {} : value;
	const text = value.trim();
	if (text.length === 0) return {};
	try {
		return JSON.parse(text);
	} catch {
		return value;
	}
}

/** 按上限收敛任意 JSON 值：字符串直接截断，对象超过上限就退化成截断后的字符串。 */
function clampJsonValue(value, max) {
	if (typeof value === "string") return truncateText(value, max);
	let encoded;
	try {
		encoded = JSON.stringify(value);
	} catch {
		return truncateText(String(value), max);
	}
	if (typeof encoded !== "string" || encoded.length <= max) return value;
	return truncateText(encoded, max);
}

/** 把事件时间（毫秒 epoch）转成 ISO-8601 UTC 字符串；不可用时返回 undefined。 */
function isoTimestamp(time) {
	const value = Number(time);
	if (!Number.isFinite(value) || value <= 0) return undefined;
	try {
		return new Date(value).toISOString();
	} catch {
		return undefined;
	}
}

/** 组装一条记录，并补上 seq / timestamp 两个公共字段。 */
function makeRecord(event, fields) {
	const record = { ...fields };
	const seq = Number(event?.seq);
	if (Number.isFinite(seq)) record.seq = seq;
	const timestamp = isoTimestamp(event?.time);
	if (timestamp !== undefined) record.timestamp = timestamp;
	return record;
}

/**
 * 创建一个投影器。
 *
 * 投影器记住本轮会话里 callId → 工具名 的映射，用来给 tool_result 回填工具名
 * （DSH 的 tool/result 只带 callId）。补录历史时按序重放即可重建该映射。
 *
 * @param options.maxFieldChars 单条字段的截断上限。
 * @returns {{project: (event: unknown) => object | null, reset: () => void}}
 */
export function createProjection(options = {}) {
	const maxFieldChars = Number.isFinite(options.maxFieldChars) ? Number(options.maxFieldChars) : DEFAULT_MAX_FIELD_CHARS;
	/** callId → 工具名。 */
	const toolNames = new Map();

	/** 记忆工具调用，供后续 tool_result 回填名字。 */
	function rememberCall(data) {
		const callId = data.callId ?? data.id;
		const name = typeof data.name === "string" ? data.name : "";
		if (typeof callId === "string" && callId.length > 0 && name.length > 0) toolNames.set(callId, name);
		return { callId, name };
	}

	/**
	 * 把一条 session event 投影成记录；不属于投影范围时返回 null。
	 * @param event DSH session event（含 type / seq / time / data）。
	 * @returns 规范记录对象，或 null。
	 */
	function project(event) {
		if (event === null || typeof event !== "object") return null;
		const type = event.type;
		const data = event.data !== null && typeof event.data === "object" ? event.data : {};

		if (type === "user/message") {
			// 只收真实用户输入；插件/系统注入的 notice（source.kind === "plugin"）不进记忆。
			if (data.source?.kind !== "user") return null;
			const text = textOf(data.content).trim();
			if (text.length === 0) return null;
			return makeRecord(event, { type: "message", role: "user", text: truncateText(text, maxFieldChars) });
		}

		if (type === "assistant/message") {
			const message = data.message !== null && typeof data.message === "object" ? data.message : {};
			// 只取 text 块：reasoning 不入记忆，tool-call 块交给 tool/call 事件去记。
			const text = textOf(message.content).trim();
			if (text.length === 0) return null;
			return makeRecord(event, { type: "message", role: "assistant", text: truncateText(text, maxFieldChars) });
		}

		if (type === "tool/call") {
			const { name } = rememberCall(data);
			if (name.length === 0) return null;
			return makeRecord(event, {
				type: "tool_call",
				name,
				arguments: clampJsonValue(parseArguments(data.arguments), maxFieldChars)
			});
		}

		if (type === "tool/result") {
			const message = data.message !== null && typeof data.message === "object" ? data.message : {};
			const callId = data.toolCallId ?? message.toolCallId ?? message.source?.callId ?? data.callId;
			const name = (typeof callId === "string" ? toolNames.get(callId) : undefined) ?? (typeof data.name === "string" ? data.name : "");
			const content = textOf(message.content ?? data.content);
			const isError = data.error !== undefined && data.error !== null
				|| message.isError === true
				|| (message.error !== undefined && message.error !== null);
			return makeRecord(event, {
				type: "tool_result",
				name,
				content: truncateText(content, maxFieldChars),
				is_error: isError === true
			});
		}

		// 其余事件（system/message、request/header、turn/*、step/*、session-log-* …）整条丢弃。
		return null;
	}

	/** 清空 callId 映射（重放历史前调用）。 */
	function reset() {
		toolNames.clear();
	}

	return { project, reset };
}
