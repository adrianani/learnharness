"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SubscriptionState } from "@/src/core";
import { notifySettingsSaved } from "./settings-signal";

export function SubscriptionLogin() {
	const [state, setState] = useState<SubscriptionState | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [value, setValue] = useState("");
	const lifetime = useRef<AbortController | null>(null);
	const connected = useRef<boolean | undefined>(undefined);

	const accept = useCallback((next: SubscriptionState) => {
		const changed = connected.current !== undefined && connected.current !== next.connected;
		connected.current = next.connected;
		setState(next);
		if (changed) notifySettingsSaved("keys");
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		lifetime.current = controller;
		void fetch("/api/subscription", { cache: "no-store", signal: controller.signal })
			.then(async (response) => {
				const body = await response.json();
				if (!response.ok) throw new Error(body.error ?? "Could not load ChatGPT sign-in.");
				if (!controller.signal.aborted) accept(body);
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load ChatGPT sign-in.");
			});
		return () => { controller.abort(); lifetime.current = null; };
	}, [accept]);

	useEffect(() => {
		if (state?.status !== "pending" || busy) return;
		const controller = new AbortController();
		let timer: number;
		async function poll() {
			try {
				const response = await fetch("/api/subscription", { cache: "no-store", signal: controller.signal });
				const body = await response.json();
				if (!response.ok) throw new Error(body.error ?? "Could not check sign-in status.");
				if (!controller.signal.aborted) { accept(body); setError(null); }
			} catch (error) {
				if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not check sign-in status.");
			} finally {
				if (!controller.signal.aborted) timer = window.setTimeout(poll, 1000);
			}
		}
		timer = window.setTimeout(poll, 300);
		return () => { controller.abort(); clearTimeout(timer); };
	}, [state?.status, busy, accept]);

	useEffect(() => { setValue(""); }, [state?.prompt?.id]);

	async function mutate(method: "POST" | "DELETE", answer?: { promptId: string; value: string }) {
		const signal = lifetime.current?.signal;
		if (busy || !signal || signal.aborted) return;
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/subscription", {
				method, signal,
				...(answer ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(answer) } : {}),
			});
			const body = await response.json();
			if (!response.ok) throw new Error(body.error ?? "ChatGPT sign-in request failed.");
			if (!signal.aborted) { accept(body); setValue(""); }
		} catch (error) {
			if (!signal.aborted) setError(error instanceof Error ? error.message : "ChatGPT sign-in request failed.");
		} finally {
			if (!signal.aborted) setBusy(false);
		}
	}

	const pending = state?.status === "pending";
	const buttonClass = "rounded-sm border border-border bg-background px-3 py-1.5 font-ui text-xs transition-colors hover:border-muted-foreground/50 disabled:opacity-40";
	return (
		<div className="flex flex-col gap-2 py-2 text-xs" data-testid="subscription-login">
			<div className="flex flex-wrap items-center gap-3">
				<span className="font-ui text-foreground">ChatGPT subscription</span>
				{state?.connected ? (
					<><span role="status" className="text-muted-foreground">Connected</span><button type="button" className={buttonClass} disabled={busy} onClick={() => void mutate("DELETE")}>Disconnect</button></>
				) : pending ? (
					<><span role="status" className="text-muted-foreground">Waiting for sign-in…</span><button type="button" className={buttonClass} disabled={busy} onClick={() => void mutate("DELETE")}>Cancel sign-in</button></>
				) : (
					<button type="button" className={buttonClass} disabled={busy || (!state && !error)} onClick={() => void mutate("POST")}>{busy ? "Starting sign-in…" : "Sign in with ChatGPT"}</button>
				)}
			</div>
			<p className="text-muted-foreground">Use your eligible ChatGPT plan. Subscription limits apply; API credits are separate. While connected, OpenAI models use this subscription instead of your API key.</p>
			{pending && state.authUrl && <a className="w-fit underline underline-offset-2" href={state.authUrl} target="_blank" rel="noopener noreferrer">Continue sign-in in your browser ↗</a>}
			{pending && state.prompt && (
				<form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); if (state.prompt && value.trim()) void mutate("POST", { promptId: state.prompt.id, value }); }}>
					<label className="flex flex-col gap-1">
						<span className="text-muted-foreground">{state.prompt.message}</span>
						{state.prompt.type === "select" ? (
							<select aria-label="Sign-in response" value={value} onChange={(event) => setValue(event.target.value)} className="rounded-sm border border-border bg-background p-1.5" disabled={busy}>
								<option value="">Choose…</option>{state.prompt.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
							</select>
						) : (
							<input aria-label="Sign-in response" type={state.prompt.type === "secret" || state.prompt.type === "manual_code" ? "password" : "text"} value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" spellCheck={false} disabled={busy} className="min-w-0 rounded-sm border border-border bg-background p-1.5" />
						)}
					</label>
					<button type="submit" className={`${buttonClass} w-fit`} disabled={busy || !value.trim()}>Submit sign-in response</button>
				</form>
			)}
			{(error || state?.error) && <p role="alert" className="text-red-400">{error ?? state?.error}</p>}
		</div>
	);
}
