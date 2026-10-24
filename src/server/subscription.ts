import { randomUUID } from "node:crypto";
import type { AuthPrompt, Models } from "@earendil-works/pi-ai";
import { piModels } from "../agent/models.ts";
import { subscriptionCredentials } from "../agent/subscription-credentials.ts";

import type { SubscriptionState } from "../core/contracts/subscription.ts";

type Credentials = Pick<typeof subscriptionCredentials, "connected" | "deviceId">;

/** One bounded local login; only non-secret interaction state reaches HTTP. */
export class SubscriptionLogin {
	private state: Omit<SubscriptionState, "connected"> = { status: "idle" };
	private controller?: AbortController;
	private task?: Promise<void>;
	private answerPrompt?: (value: string) => void;
	private disconnecting = false;

	constructor(
		private readonly models: Pick<Models, "login" | "logout">,
		private readonly credentials: Credentials,
		private readonly timeoutMs = 10 * 60_000,
	) {}

	snapshot(): SubscriptionState {
		const connected = this.credentials.connected();
		return { ...this.state, connected, status: this.state.status === "idle" && connected ? "connected" : this.state.status };
	}

	start(): SubscriptionState {
		if (this.disconnecting) throw new Error("Disconnect in progress");
		if (this.task || this.credentials.connected()) return this.snapshot();
		const controller = new AbortController();
		this.controller = controller;
		this.state = { status: "pending" };
		const timer = setTimeout(() => controller.abort(new Error("timeout")), this.timeoutMs);
		timer.unref();
		this.task = (async () => {
			try {
				const deviceId = await this.credentials.deviceId();
				await this.models.login("openai", "oauth", {
					signal: controller.signal,
					notify: (event) => {
						if (!controller.signal.aborted && event.type === "auth_url") this.state.authUrl = event.url;
					},
					prompt: (prompt) => this.prompt(prompt, controller.signal),
				}, { getDeviceId: () => deviceId, agentName: "LearnHarness" });
				this.state = { status: "connected" };
			} catch (error) {
				// Provider error bodies may contain credentials. Never forward them.
				const portBusy = error instanceof Error && error.message.includes("Port 1455 is in use");
				this.state = {
					status: "error",
					error: controller.signal.aborted
						? "Sign-in expired or was cancelled. Try again."
						: portBusy
							? "Port 1455 is in use. Cancel any other Codex or ChatGPT login and try again."
							: "ChatGPT sign-in failed. Try again; check that subscription access is available for your account.",
				};
			} finally {
				clearTimeout(timer);
				this.answerPrompt = undefined;
				this.controller = undefined;
				this.task = undefined;
			}
		})();
		return this.snapshot();
	}

	private prompt(prompt: AuthPrompt, loginSignal: AbortSignal): Promise<string> {
		const signal = prompt.signal ? AbortSignal.any([loginSignal, prompt.signal]) : loginSignal;
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const id = randomUUID();
		const cleanup = () => {
			signal.removeEventListener("abort", abort);
			if (this.state.prompt?.id === id) {
				delete this.state.prompt;
				this.answerPrompt = undefined;
			}
		};
		const abort = () => { cleanup(); reject(signal.reason); };
		if (signal.aborted) return Promise.reject(signal.reason);
		this.state.prompt = {
			id, type: prompt.type, message: prompt.message,
			...(prompt.type === "select" ? { options: prompt.options.map((option) => ({ value: option.id, label: option.label })) } : {}),
		};
		this.answerPrompt = (value) => { cleanup(); resolve(value); };
		signal.addEventListener("abort", abort, { once: true });
		return promise;
	}

	answer(id: string, value: string): boolean {
		if (this.state.prompt?.id !== id || !this.answerPrompt) return false;
		if (this.state.prompt.options && !this.state.prompt.options.some((option) => option.value === value)) return false;
		this.answerPrompt(value);
		return true;
	}

	async disconnect(): Promise<SubscriptionState> {
		this.disconnecting = true;
		try {
			this.controller?.abort();
			// Login may already be committing credentials. Delete only after it settles.
			await this.task;
			await this.models.logout("openai");
			this.state = { status: "idle" };
			return this.snapshot();
		} finally {
			this.disconnecting = false;
		}
	}
}

const KEY = Symbol.for("lh.subscriptionLogin");
export function subscriptionLogin(): SubscriptionLogin {
	const global = globalThis as Record<symbol, SubscriptionLogin | undefined>;
	return global[KEY] ??= new SubscriptionLogin(piModels(), subscriptionCredentials);
}
