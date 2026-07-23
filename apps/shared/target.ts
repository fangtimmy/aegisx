export type TargetEndpointProtocol =
	| "http"
	| "https"
	| "ws"
	| "wss"
	| "tcp"
	| "udp";

export type TargetEndpoint = {
	name: string;
	address: string;
	protocol: TargetEndpointProtocol;
	guidance?: string[];
};

export type TargetStatus =
	| "absent"
	| "starting"
	| "running"
	| "stopping"
	| "failed";

export type TargetState = {
	status: TargetStatus;
	endpoints: TargetEndpoint[];
	expiresAt: string | null;
	message?: string;
};

export function isActiveTarget(target: TargetState): boolean {
	return (
		target.status === "starting" ||
		target.status === "running" ||
		target.status === "stopping"
	);
}

export type RemoteTargetInfo = {
	name: string;
	services: string[];
};
