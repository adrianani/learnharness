import { subscriptionLogin } from "@/src/server";

export const runtime = "nodejs";

function json(body: unknown, status = 200) {
	return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function forbidden(request: Request): boolean {
	const origin = request.headers.get("origin");
	// Next may construct request.url with the bind hostname rather than Host.
	const url = new URL(request.url);
	const expected = `${url.protocol}//${request.headers.get("host") ?? url.host}`;
	return request.headers.get("sec-fetch-site") === "cross-site" || (origin !== null && origin !== expected);
}

export async function GET() {
	try {
		return json(subscriptionLogin().snapshot());
	} catch {
		return json({ error: "Could not read subscription credentials." }, 500);
	}
}

export async function POST(request: Request) {
	if (forbidden(request)) return json({ error: "Cross-origin sign-in is not allowed." }, 403);
	const text = await request.text();
	if (text.length > 16_384) return json({ error: "Sign-in response is too large." }, 400);
	let answer: unknown;
	if (text) {
		try { answer = JSON.parse(text); }
		catch { return json({ error: "Invalid sign-in response." }, 400); }
		if (!answer || typeof answer !== "object" || !("promptId" in answer) || !("value" in answer) || typeof answer.promptId !== "string" || typeof answer.value !== "string" || !answer.value.trim()) {
			return json({ error: "Expected a prompt ID and response." }, 400);
		}
	}
	try {
		const login = subscriptionLogin();
		if (answer && typeof answer === "object" && "promptId" in answer && "value" in answer) {
			if (!login.answer(answer.promptId as string, answer.value as string)) return json({ error: "This sign-in prompt is no longer active." }, 409);
			return json(login.snapshot());
		}
		return json(login.start());
	} catch {
		return json({ error: "Could not start ChatGPT sign-in. Try again." }, 500);
	}
}

export async function DELETE(request: Request) {
	if (forbidden(request)) return json({ error: "Cross-origin disconnect is not allowed." }, 403);
	try {
		return json(await subscriptionLogin().disconnect());
	} catch {
		return json({ error: "Could not disconnect ChatGPT. Try again." }, 500);
	}
}
