/**
 * subprocess 调用的回归测试。
 *
 * 这里钉的是一个真实 bug：装机后发现「有输出」被误报成「无输出」——原先用 collect
 * 模式的 `handle.collected[...].readFrom()`，装机环境下读数器始终为空。现在改成
 * pipe 模式的 Node 流（spawn 后立刻挂读取器，done 落地后再取文本），collect 快照只兜底。
 * 因此下面钉两件事：晚到的输出必须被读到；完全无输出时必须给出可定位的诊断。
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createTools } from "../lib/tools.js";

/**
 * 造一个假句柄：输出在 spawn 之后延迟一小会儿才写入流，模拟真实子进程。
 *
 * @param options.stdout 标准输出文本。
 * @param options.stderr 标准错误文本。
 * @param options.exitCode 退出码。
 * @param options.streamed 是否暴露 pipe 流（false 模拟只给 collected 快照的宿主）。
 * @param options.collected 额外的 collected 快照。
 * @param options.delayMs 输出写入前的延迟。
 * @returns 假子进程句柄。
 */
function fakeHandle({ stdout = "", stderr = "", exitCode = 0, streamed = true, collected = {}, delayMs = 5 }) {
	const out = new PassThrough();
	const err = new PassThrough();
	const done = (async () => {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		if (stdout.length > 0) out.write(stdout);
		if (stderr.length > 0) err.write(stderr);
		out.end();
		err.end();
		return { exitCode, signal: null };
	})();
	const handle = { done, collected };
	if (streamed) {
		handle.stdout = out;
		handle.stderr = err;
	}
	return handle;
}

/** 造一个最小 ctx，只提供 subprocess 服务。 */
function fakeContext(handle) {
	let spawns = 0;
	const subprocess = {
		resolveExecutable: async (command) => command,
		spawn: () => {
			spawns += 1;
			return handle;
		}
	};
	return {
		spawns: () => spawns,
		get: (name) => (name === "subprocess" ? subprocess : undefined)
	};
}

function retrieveToolOf(handle) {
	const ctx = fakeContext(handle);
	const tools = createTools(ctx, { command: ["memu-dsh"], maxFieldChars: 8000 });
	return { tool: tools.find((item) => item.name === "memu_retrieve"), ctx };
}

test("memu_retrieve 解析成功时的 JSON 输出", async () => {
	const { tool } = retrieveToolOf(fakeHandle({ stdout: '{"segments":[{"text":"hi"}]}' }));
	const value = await tool.execute({ query: "hi" }, {});
	assert.deepEqual(value, { segments: [{ text: "hi" }] });
});

test("memu_retrieve 在进程退出后才读到 stderr（回归：不得误报无输出）", async () => {
	const { tool } = retrieveToolOf(fakeHandle({ stderr: "error: 401 unauthorized\n", exitCode: 1 }));
	await assert.rejects(
		() => tool.execute({ query: "hi" }, {}),
		(error) => {
			assert.match(error.message, /exit 1/);
			assert.match(error.message, /401 unauthorized/);
			assert.doesNotMatch(error.message, /无输出/);
			return true;
		}
	);
});

test("memu_retrieve 读到延迟到达的完整 stdout", async () => {
	const payload = JSON.stringify({ segments: [], files: [], resources: [] });
	const { tool } = retrieveToolOf(fakeHandle({ stdout: payload, delayMs: 30 }));
	const value = await tool.execute({ query: "hi" }, {});
	assert.deepEqual(value, { segments: [], files: [], resources: [] });
});

test("memu_retrieve 在句柄只给 collected 快照时兜底读到输出", async () => {
	const { tool } = retrieveToolOf(
		fakeHandle({
			streamed: false,
			collected: { stdout: { readFrom: () => ({ text: '{"segments":[{"text":"fallback"}]}', nextOffset: 32, lossy: false }) } }
		})
	);
	const value = await tool.execute({ query: "hi" }, {});
	assert.deepEqual(value, { segments: [{ text: "fallback" }] });
});

test("memu_retrieve 完全无输出时给出接线诊断", async () => {
	const { tool } = retrieveToolOf(fakeHandle({ streamed: false, exitCode: 1 }));
	await assert.rejects(
		() => tool.execute({ query: "hi" }, {}),
		(error) => {
			assert.match(error.message, /无输出（stdout=none stderr=none collected=empty）/);
			return true;
		}
	);
});

test("memu_retrieve 空 query 直接失败，不起子进程", async () => {
	const { tool, ctx } = retrieveToolOf(fakeHandle({ exitCode: 0 }));
	await assert.rejects(() => tool.execute({ query: "   " }, {}), /query 不能为空/);
	assert.equal(ctx.spawns(), 0);
});
