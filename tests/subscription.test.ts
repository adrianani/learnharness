import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createModels, type Models, type OAuthCredential } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { SubscriptionCredentials } from "../src/agent/subscription-credentials.ts";
import { SubscriptionLogin } from "../src/server/subscription.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-subscription-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const token = (access: string, expires = Date.now() + 3_600_000): OAuthCredential => ({ type: "oauth", access, refresh: "refresh-private", expires });

async function until(predicate: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	assert.fail("Subscription state did not settle");
}

test("concurrent collections refresh once, persist privately, and never fall back to API billing", async () => {
	const file = path.join(dir, "refresh.json");
	const first = new SubscriptionCredentials(file);
	const second = new SubscriptionCredentials(file);
	const id = await first.deviceId();
	assert.equal(await second.deviceId(), id);
	await first.modify("openai", async () => token("expired", 0));
	let refreshes = 0;
	function collection(store: InstanceType<typeof SubscriptionCredentials>) {
		const models = createModels({ credentials: store, authContext: { env: async () => "api-billing-key", fileExists: async () => false } });
		const provider = openaiProvider();
		provider.auth.oauth = {
			name: "ChatGPT",
			login: async () => token("signed-in"),
			refresh: async () => { refreshes++; return token("fresh-subscription"); },
			toAuth: async (credential) => ({ apiKey: credential.access }),
		};
		models.setProvider(provider);
		return { models, provider };
	}
	const a = collection(first);
	const b = collection(second);
	const auth = await Promise.all([a.models.getAuth("openai"), b.models.getAuth("openai")]);
	assert.equal(refreshes, 1);
	assert.deepEqual(auth.map((result) => result?.auth.apiKey), ["fresh-subscription", "fresh-subscription"]);
	assert.equal((await second.read("openai"))?.type, "oauth");
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	await first.modify("openai", async () => token("expired-again", 0));
	a.provider.auth.oauth!.refresh = async () => { throw new Error("revoked"); };
	await assert.rejects(a.models.getAuth("openai"), /refresh failed/i);
	await a.models.logout("openai");
	assert.equal(second.connected(), false);
	assert.equal((await b.models.getAuth("openai"))?.auth.apiKey, "api-billing-key");
	assert.equal(await second.deviceId(), id);
});

test("login exposes interaction state, rejects stale answers, and clears secrets on completion", async () => {
	let connected = false;
	const models: Pick<Models, "login" | "logout"> = {
		login: async (_provider, _type, interaction) => {
			interaction.notify({ type: "auth_url", url: "https://auth.openai.com/example" });
			const answer = await interaction.prompt({ type: "manual_code", message: "Paste callback", signal: interaction.signal });
			assert.equal(answer, "private-callback");
			connected = true;
			return token("private-access");
		},
		logout: async () => { connected = false; },
	};
	const login = new SubscriptionLogin(models, { connected: () => connected, deviceId: async () => "device" });
	assert.equal(login.start().status, "pending");
	await until(() => !!login.snapshot().prompt);
	const state = login.snapshot();
	assert.equal(state.authUrl, "https://auth.openai.com/example");
	assert.equal(login.answer("stale", "value"), false);
	assert.equal(login.answer(state.prompt!.id, "private-callback"), true);
	await until(() => login.snapshot().status === "connected");
	assert.deepEqual(login.snapshot(), { status: "connected", connected: true });
	assert.deepEqual(await login.disconnect(), { status: "idle", connected: false });
});

test("disconnect waits for an in-flight credential commit before deleting it", async () => {
	let connected = false;
	const commit = Promise.withResolvers<void>();
	let committing = false;
	const models: Pick<Models, "login" | "logout"> = {
		login: async () => { committing = true; await commit.promise; connected = true; return token("private"); },
		logout: async () => { connected = false; },
	};
	const login = new SubscriptionLogin(models, { connected: () => connected, deviceId: async () => "device" });
	login.start();
	await until(() => committing);
	const disconnected = login.disconnect();
	assert.throws(() => login.start(), /Disconnect in progress/);
	commit.resolve();
	assert.deepEqual(await disconnected, { status: "idle", connected: false });
});

test("login expiry cancels pending prompts", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const models: Pick<Models, "login" | "logout"> = {
		login: async (_provider, _type, interaction) => {
			await interaction.prompt({ type: "secret", message: "Response", signal: interaction.signal });
			return token("unused");
		},
		logout: async () => {},
	};
	const login = new SubscriptionLogin(models, { connected: () => false, deviceId: async () => "device" }, 20);
	login.start();
	await until(() => !!login.snapshot().prompt);
	context.mock.timers.tick(20);
	await until(() => login.snapshot().status === "error");
	assert.equal(login.snapshot().prompt, undefined);
	assert.match(login.snapshot().error!, /expired/);
});

test("provider failures never expose upstream secrets in sign-in state", async () => {
	const models: Pick<Models, "login" | "logout"> = {
		login: async () => { throw new Error("private-provider-token"); },
		logout: async () => {},
	};
	const login = new SubscriptionLogin(models, { connected: () => false, deviceId: async () => "device" });
	login.start();
	await until(() => login.snapshot().status === "error");
	assert.equal(login.snapshot().status, "error");
	assert.ok(!JSON.stringify(login.snapshot()).includes("private-provider-token"));
	assert.equal(login.snapshot().connected, false);
});
