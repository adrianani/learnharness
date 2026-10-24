import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import type { AuthOperationOptions, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";

interface SubscriptionRecord {
	deviceId?: string;
	credential?: Credential;
}

/** Separate from the flat API-key file; never reflected into process.env. */
export class SubscriptionCredentials implements CredentialStore {
	constructor(private readonly file = path.join(PATHS.data, "subscription.json")) {}

	private record(): SubscriptionRecord {
		try {
			const value = JSON.parse(fs.readFileSync(this.file, "utf8")) as SubscriptionRecord;
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid subscription record");
			if (value.credential && (value.credential.type !== "oauth" || typeof value.credential.access !== "string" || typeof value.credential.refresh !== "string" || typeof value.credential.expires !== "number")) {
				throw new Error("Invalid subscription credential");
			}
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error; // A corrupt credential must not silently fall back to API billing.
		}
	}

	private save(record: SubscriptionRecord): void {
		const tmp = `${this.file}.${randomUUID()}.tmp`;
		try {
			fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
			fs.renameSync(tmp, this.file);
		} finally {
			fs.rmSync(tmp, { force: true });
		}
	}

	private async locked<T>(fn: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
		options?.signal?.throwIfAborted();
		fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
		const release = await lockfile.lock(this.file, {
			realpath: false,
			retries: { retries: 100, minTimeout: 100, maxTimeout: 200 },
			stale: 60_000,
		});
		try {
			options?.signal?.throwIfAborted();
			return await fn();
		} finally {
			await release();
		}
	}

	connected(): boolean {
		return this.record().credential?.type === "oauth";
	}

	async deviceId(): Promise<string> {
		return this.locked(async () => {
			const record = this.record();
			if (!record.deviceId) {
				record.deviceId = randomUUID();
				this.save(record);
			}
			return record.deviceId;
		});
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return providerId === "openai" ? this.record().credential : undefined;
	}

	async list(options?: AuthOperationOptions) {
		options?.signal?.throwIfAborted();
		return this.connected() ? [{ providerId: "openai", type: "oauth" as const }] : [];
	}

	async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions) {
		if (providerId !== "openai") throw new Error("Only OpenAI subscriptions are supported");
		return this.locked(async () => {
			const record = this.record();
			const credential = await fn(record.credential);
			if (credential) {
				if (credential.type !== "oauth") throw new Error("Expected subscription credentials");
				record.credential = credential;
				this.save(record);
			}
			return record.credential;
		}, options);
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		if (providerId !== "openai") return;
		await this.locked(async () => {
			const record = this.record();
			delete record.credential;
			this.save(record);
		}, options);
	}
}

export const subscriptionCredentials = new SubscriptionCredentials();
