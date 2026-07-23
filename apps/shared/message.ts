export type InboxKind = "user" | "child_result" | "resume";

export type AegisXMetadata = {
	handoff?: {
		agentId: string;
		agentName: string;
		status: string;
	};
};

export type AegisXMessage = {
	role: "aegisx";
	id: string;
	kind: InboxKind;
	text: string;
	timestamp: number;
	metadata?: AegisXMetadata;
};
