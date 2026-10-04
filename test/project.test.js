/**
 * 投影规则的单元测试：钉住「哪些事件进记忆、进成什么形状、哪些必须丢弃」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createProjection, truncateText } from "../lib/project.js";

const TIME = 1791107158154;

/** 造一条用户消息事件。 */
function userEvent(seq, text, sourceKind = "user") {
	return { type: "user/message", seq, time: TIME + seq, data: { role: "user", source: { kind: sourceKind }, content: [{ type: "text", text }] } };
}

/** 造一条助手消息事件（内容块可自定义）。 */
function assistantEvent(seq, content) {
	return { type: "assistant/message", seq, time: TIME + seq, data: { turn: 1, step: seq, message: { role: "assistant", content } } };
}

test("用户消息投影成 message/user，并带上 seq 与 ISO 时间", () => {
	const projection = createProjection();
	const record = projection.project(userEvent(7, "帮我把这个脚本重构成三步"));
	assert.equal(record.type, "message");
	assert.equal(record.role, "user");
	assert.equal(record.text, "帮我把这个脚本重构成三步");
	assert.equal(record.seq, 7);
	assert.equal(record.timestamp, new Date(TIME + 7).toISOString());
});

test("插件注入的 notice 不进记忆", () => {
	const projection = createProjection();
	assert.equal(projection.project(userEvent(8, "dsh-rules: 规则已生效", "plugin")), null);
});

test("助手消息只取 text 块：reasoning 与 tool-call 块都不进记忆", () => {
	const projection = createProjection();
	const record = projection.project(assistantEvent(9, [
		{ type: "reasoning", text: "内部推理，不该进记忆" },
		{ type: "text", text: "我先看文件。" },
		{ type: "tool-call", id: "call_1", name: "read", arguments: "{\"path\":\"a.ts\"}" }
	]));
	assert.deepEqual(record, {
		type: "message",
		role: "assistant",
		text: "我先看文件。",
		seq: 9,
		timestamp: new Date(TIME + 9).toISOString()
	});
});

test("只有 reasoning 的助手消息不产出记录", () => {
	const projection = createProjection();
	assert.equal(projection.project(assistantEvent(10, [{ type: "reasoning", text: "只想不说话" }])), null);
});

test("工具调用来自 tool/call 事件，arguments 解析成 JSON", () => {
	const projection = createProjection();
	const record = projection.project({ type: "tool/call", seq: 11, time: TIME + 11, data: { callId: "call_1", name: "bash", arguments: "{\"command\":\"ls\"}" } });
	assert.deepEqual(record.arguments, { command: "ls" });
	assert.equal(record.type, "tool_call");
	assert.equal(record.name, "bash");
});

test("arguments 不是合法 JSON 时原样保留；缺 name 时丢弃", () => {
	const projection = createProjection();
	const record = projection.project({ type: "tool/call", seq: 12, time: TIME + 12, data: { callId: "call_2", name: "bash", arguments: "not-json" } });
	assert.equal(record.arguments, "not-json");
	assert.equal(projection.project({ type: "tool/call", seq: 13, time: TIME + 13, data: { callId: "call_3", arguments: "{}" } }), null);
});

test("工具结果回填工具名，并区分 is_error", () => {
	const projection = createProjection();
	projection.project({ type: "tool/call", seq: 14, time: TIME + 14, data: { callId: "call_9", name: "read", arguments: "{}" } });
	const ok = projection.project({ type: "tool/result", seq: 15, time: TIME + 15, data: { callId: "call_9", toolCallId: "call_9", message: { role: "tool", source: { kind: "tool", callId: "call_9" }, content: [{ type: "text", text: "文件内容" }] } } });
	assert.equal(ok.type, "tool_result");
	assert.equal(ok.name, "read");
	assert.equal(ok.content, "文件内容");
	assert.equal(ok.is_error, false);

	const failed = projection.project({ type: "tool/result", seq: 16, time: TIME + 16, data: { error: { message: "boom" }, callId: "call_9", toolCallId: "call_9", message: { role: "tool", source: { kind: "tool", callId: "call_9" }, content: [{ type: "text", text: "失败了" }] } } });
	assert.equal(failed.is_error, true);
});

test("噪音事件整条丢弃", () => {
	const projection = createProjection();
	const noise = [
		"request/header",
		"request/context",
		"system/message",
		"session/title",
		"session/title-llm-request",
		"session-log-deepseek/delivery-accepted",
		"turn/start",
		"step/start",
		"step/end",
		"plan/mode",
		"permission/preset",
		"sandbox/mode",
		"approval/policy",
		"model/selection",
		"command/run",
		"agent/inbox/spliced",
		"session"
	];
	for (const type of noise) {
		assert.equal(projection.project({ type, seq: 1, time: TIME, data: { content: [{ type: "text", text: "不该进记忆" }] } }), null, `${type} 必须被丢弃`);
	}
	assert.equal(projection.project(null), null);
	assert.equal(projection.project({ seq: 1 }), null);
});

test("长文本被截断并标注长度", () => {
	const projection = createProjection({ maxFieldChars: 10 });
	const record = projection.project(userEvent(17, "0123456789abcdef"));
	assert.equal(record.text, "0123456789\n…[truncated 6 chars]");
	assert.equal(truncateText("short", 10), "short");
	assert.equal(truncateText("short", 100), "short");
});

test("缺少 time 时不写 timestamp 字段", () => {
	const projection = createProjection();
	const record = projection.project({ type: "user/message", seq: 18, data: { source: { kind: "user" }, content: [{ type: "text", text: "hi" }] } });
	assert.equal("timestamp" in record, false);
	assert.equal(record.seq, 18);
});

test("超长的 arguments 退化成截断后的字符串", () => {
	const projection = createProjection({ maxFieldChars: 20 });
	const record = projection.project({ type: "tool/call", seq: 19, time: TIME + 19, data: { callId: "call_big", name: "bash", arguments: JSON.stringify({ command: "x".repeat(200) }) } });
	assert.equal(typeof record.arguments, "string");
	assert.match(record.arguments, /truncated/);
});
