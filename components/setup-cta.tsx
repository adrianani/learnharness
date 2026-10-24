"use client";
/** Composer setup gates use the model catalog's configured-provider truth,
 * including API keys and ChatGPT subscriptions. Tool-only keys unlock no models. */

import { useCallback, useEffect, useState } from "react";
import type { ModelCatalogResponse } from "@/src/core";
import { useModelCatalog } from "@/components/model-picker";
import { useSettingsSaved } from "@/components/settings-signal";


/** True only after a successful catalog read finds no configured provider.
 * Refreshed after either API-key or subscription changes. */
export function useZeroKeys(): boolean {
	const [zeroKeys, setZeroKeys] = useState(false);
	const read = useCallback(() => {
		fetch("/api/models")
			.then((r) => {
				if (!r.ok) throw new Error("Could not read configured providers");
				return r.json() as Promise<ModelCatalogResponse>;
			})
			.then((body) => setZeroKeys(!body.providers.some((provider) => provider.keyPresent)))
			.catch(() => {});
	}, []);
	useEffect(() => {
		read();
	}, [read]);
	useSettingsSaved((section) => {
		if (section === "keys") read();
	});
	return zeroKeys;
}

/** The pill itself — the models CTA's chrome and placement, the keys
 *  chain's copy. testid "setup-cta-keys" (the models CTA keeps
 *  "setup-cta"; probes can tell them apart). */
export function ZeroKeysPill({ onOpen, inline = false }: { onOpen: () => void; inline?: boolean }) {
	const button = (
		<button
			type="button"
			data-testid="setup-cta-keys"
			onClick={onOpen}
			className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent cursor-pointer"
		>
			Connect a provider
		</button>
	);
	return inline ? button : <div className="pointer-events-auto mb-2 flex justify-center">{button}</div>;
}
/** Pure: the strong slot is pinned to a provider whose key is GONE (owner
 *  interlude, 2026-09-25 — the original deleted-key scenario). The catalog
 *  already knows both halves: slots.strong is the resolved pin, providers[]
 *  lists only PRESENT-key providers (keyless ones are absent, the same
 *  discipline as the search engines). False when the strong slot is unset
 *  (the models guard owns that case — this check only runs when slots ARE
 *  configured) or the catalog hasn't loaded (the server gate remains the
 *  belt). Exported for pins. */
export function strongKeyless(catalog: ModelCatalogResponse | undefined): boolean {
	const strong = catalog?.slots.strong;
	if (!strong) return false;
	return !catalog.providers.some((p) => p.id === strong.model.provider && p.keyPresent);
}

/** The strong-slot keyless truth for the PRE-SEND guard (home / /chat/new):
 *  the catalog seam with re-reads on BOTH signals that can flip it — "keys"
 *  (a provider key saved or deleted) and "models" (the strong slot
 *  re-pinned). Live-updates with the page, never mid-send. */
export function useStrongKeyless(): boolean {
	const { catalog, refresh } = useModelCatalog();
	useSettingsSaved((section) => {
		if (section === "keys" || section === "models") refresh();
	});
	return strongKeyless(catalog);
}
