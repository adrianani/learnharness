/** Non-secret state shared by subscription HTTP handlers and sign-in controls. */
export interface SubscriptionState {
	connected: boolean;
	status: "idle" | "pending" | "connected" | "error";
	authUrl?: string;
	prompt?: {
		id: string;
		type: "text" | "secret" | "select" | "manual_code";
		message: string;
		options?: { value: string; label: string }[];
	};
	error?: string;
}
