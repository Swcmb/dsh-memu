/**
 * 导出器的单元测试：路径编码、全量补录、续读不重复、实时追加与 horizon 去重。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExporter, encodeCwd } from "../lib/exporter.js";

const TIME = 1791107158154;

/** 造一条用户消息事件。 */
function userEvent(seq, text) {
	return { type: "user/message", seq, time: TIME + seq, data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text }] } };
}

/** 造一条助手文本事件。 */
function assistantEvent(seq, text) {
	return { type: "assistant/message", seq, time: TIME + seq, data: { turn: 1, step: seq, message: { role: "assistant", content: [{ type: "text", text }] } } };
}

/** 造一条必须被丢弃的噪音事件。 */
function noiseEvent(seq) {
	return { type: "request/header", seq, time: TIME + seq, data: { header: { config: {} }, tools: [{ name: "whatever" }] } };
}

/** 假会话：只实现导出器用到的那几个成员。 */
function makeSession(id, cwd, events) {
	return {
		id,
		header: { id, cwd },
		get seq() {
			return events.length === 0 ? 0 : events[events.length - 1].seq;
		},
		snapshotEvents() {
			return events;
		}
	};
}

/** 读回导出文件里的记录。 */
async function readRecords(file) {
	const text = await readFile(file, "utf8");
	return text.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}

/** 建一个临时转录根目录。 */
async function tempDir() {
	return await mkdtemp(join(tmpdir(), "dsh-memu-"));
}

test("cwd 编码复刻 DSH 形态", () => {
	assert.equal(encodeCwd("D:\\memU"), "--D-memU--");
	assert.equal(encodeCwd("C:\\Users\\Swcmb\\.dsh\\aik_auto_memory_use"), "--C-Users-Swcmb-.dsh-aik_auto_memory_use--");
	assert.equal(encodeCwd(""), "--unknown--");
	assert.equal(encodeCwd(undefined), "--unknown--");
});

test("首次跟踪全量补录，噪音不进文件", async () => {
	const dir = await tempDir();
	const session = makeSession("session-a", "D:\\memU", [userEvent(1, "你好"), noiseEvent(2), assistantEvent(3, "在的")]);
	const exporter = createExporter({ dir });
	await exporter.track(session);

	const file = join(dir, "--D-memU--", "session-a.jsonl");
	const records = await readRecords(file);
	assert.deepEqual(records.map((record) => [record.seq, record.type, record.role ?? record.name]), [[1, "message", "user"], [3, "message", "assistant"]]);
	assert.equal(records[0].timestamp, new Date(TIME + 1).toISOString());
});

test("重新跟踪同一会话只补新事件，不重复", async () => {
	const dir = await tempDir();
	const events = [userEvent(1, "第一条"), assistantEvent(3, "回一条")];
	await createExporter({ dir }).track(makeSession("session-b", "D:\\memU", events));
	await createExporter({ dir }).track(makeSession("session-b", "D:\\memU", [...events, userEvent(4, "第二条")]));

	const records = await readRecords(join(dir, "--D-memU--", "session-b.jsonl"));
	assert.deepEqual(records.map((record) => record.seq), [1, 3, 4]);
});

test("实时追加写入新事件，已在补录窗口内的事件被丢弃", async () => {
	const dir = await tempDir();
	const session = makeSession("session-c", "D:\\memU", [userEvent(1, "补录里的")]);
	const exporter = createExporter({ dir });
	await exporter.track(session);

	exporter.append(session, userEvent(1, "重复的，应被丢弃"));
	exporter.append(session, userEvent(2, "实时追加的"));
	await exporter.flush();

	const records = await readRecords(join(dir, "--D-memU--", "session-c.jsonl"));
	assert.deepEqual(records.map((record) => [record.seq, record.text]), [[1, "补录里的"], [2, "实时追加的"]]);
});

test("未跟踪的会话不会写出文件", async () => {
	const dir = await tempDir();
	const exporter = createExporter({ dir });
	exporter.append(makeSession("session-untracked", "D:\\memU", []), userEvent(1, "x"));
	await exporter.flush();
	await assert.rejects(readFile(join(dir, "--D-memU--", "session-untracked.jsonl"), "utf8"));
});

test("多个 cwd 的会话按编码目录分开落盘", async () => {
	const dir = await tempDir();
	const exporter = createExporter({ dir });
	await exporter.track(makeSession("session-d", "D:\\memU", [userEvent(1, "a")]));
	await exporter.track(makeSession("session-e", "C:\\Users\\Swcmb", [userEvent(1, "b")]));

	assert.equal((await readRecords(join(dir, "--D-memU--", "session-d.jsonl"))).length, 1);
	assert.equal((await readRecords(join(dir, "--C-Users-Swcmb--", "session-e.jsonl"))).length, 1);
});
