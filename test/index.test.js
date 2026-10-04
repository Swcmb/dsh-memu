/**
 * 插件入口接线的回归测试。
 *
 * 钉的是一个真实场景：同一个进程里插件被加载两次（bundle 层与 patch overlay 各一份）
 * 时，`systemPrompt.section` 会因为段落名重复而抛错。抛出会让插件的 apply 失败、
 * 把整棵插件树的加载拖垮，所以这里钉住「重复注册必须降级成告警」，
 * 以及「服务缺失时必须安全跳过」。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { apply, INSTRUCTION_TEXT } from "../lib/index.js";

/**
 * 造一个记录调用的假 ctx。
 *
 * @param options.failSection 让 systemPrompt.section 抛「段落已注册」。
 * @returns 带观测字段的假上下文。
 */
function fakeContext({ failSection = false } = {}) {
	const sections = [];
	const tools = [];
	const logs = [];
	const services = {
		systemPrompt: {
			section: (definition) => {
				if (failSection) throw new Error('prompt section "memu-memory" is already registered');
				sections.push(definition);
			}
		},
		tools: { register: (definition) => tools.push(definition) },
		sessions: { list: () => [] }
	};
	return {
		sections,
		tools,
		logs,
		get: (name) => services[name],
		on: () => {},
		logger: {
			info: (message) => logs.push(["info", message]),
			warn: (message) => logs.push(["warn", message])
		}
	};
}

test("apply 注册常驻指令与三个工具", () => {
	const ctx = fakeContext();
	apply(ctx, {});
	assert.equal(ctx.sections.length, 1);
	assert.equal(ctx.sections[0].name, "memu-memory");
	assert.equal(ctx.sections[0].text, INSTRUCTION_TEXT);
	assert.deepEqual(
		ctx.tools.map((definition) => definition.name),
		["memu_retrieve", "memu_bridge_prepare", "memu_bridge_commit"]
	);
	assert.equal(ctx.logs.some(([level, message]) => level === "info" && message.includes("已加载")), true);
});

test("同进程重复加载：段落名重复时降级成告警，其余接线照旧", () => {
	const ctx = fakeContext({ failSection: true });
	assert.doesNotThrow(() => apply(ctx, {}));
	const warnings = ctx.logs.filter(([level]) => level === "warn").map(([, message]) => message);
	assert.equal(warnings.some((message) => message.includes("注册常驻指令失败")), true);
	assert.equal(warnings.some((message) => message.includes("已存在")), true);
	assert.equal(ctx.tools.length, 3);
});

/**
 * 假 ctx：服务一开始不存在，`provide()` 之后才出现并触发 `internal/service` 事件。
 * 这是真实宿主的时序（Cordis 并发加载兄弟插件），不是假想场景。
 *
 * @returns 可观测、可手动提供服务的测试台。
 */
function lateServiceContext() {
	const sections = [];
	const tools = [];
	const logs = [];
	const handlers = [];
	const services = {};
	const ctx = {
		get: (name) => services[name],
		on: (event, handler) => {
			handlers.push([event, handler]);
			return () => {};
		},
		logger: {
			info: (message) => logs.push(["info", message]),
			warn: (message) => logs.push(["warn", message])
		}
	};
	return {
		ctx,
		sections,
		tools,
		logs,
		provide(name, value) {
			services[name] = value;
			for (const [event, handler] of handlers) {
				if (event === "internal/service") handler(name, value);
			}
		}
	};
}

test("服务晚于 apply 就绪时，接线由 internal/service 事件补上", () => {
	const rig = lateServiceContext();
	assert.doesNotThrow(() => apply(rig.ctx, {}));
	assert.equal(rig.tools.length, 0);
	assert.equal(rig.sections.length, 0);

	rig.provide("tools", { register: (definition) => rig.tools.push(definition) });
	assert.deepEqual(
		rig.tools.map((definition) => definition.name),
		["memu_retrieve", "memu_bridge_prepare", "memu_bridge_commit"]
	);
	assert.equal(rig.sections.length, 0);

	rig.provide("systemPrompt", { section: (definition) => rig.sections.push(definition) });
	assert.equal(rig.sections.length, 1);
	assert.equal(rig.sections[0].name, "memu-memory");
	assert.equal(rig.sections[0].text, INSTRUCTION_TEXT);
});

test("服务不可用时 apply 不抛错，也不假装接线成功（fail-open）", () => {
	const logs = [];
	const ctx = { get: () => undefined, on: () => () => {}, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } };
	assert.doesNotThrow(() => apply(ctx, {}));
	assert.equal(logs.some((message) => message.includes("已加载")), true);
	assert.equal(logs.some((message) => message.includes("服务不可用")), false);
});

test("配置开关可以逐块关掉接线", () => {
	const ctx = fakeContext();
	apply(ctx, { instructionEnabled: false, toolEnabled: false, exportEnabled: false });
	assert.equal(ctx.sections.length, 0);
	assert.equal(ctx.tools.length, 0);
	assert.equal(ctx.logs.some(([level, message]) => level === "info" && message.includes("指令=关")), true);
});
