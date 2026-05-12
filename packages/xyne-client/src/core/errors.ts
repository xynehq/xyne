export class XyneError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.name = "XyneError";
		this.code = code;
	}
}

export class XyneAuthError extends XyneError {
	constructor(message: string) {
		super(message, "AUTH_ERROR");
		this.name = "XyneAuthError";
	}
}

export class XyneNetworkError extends XyneError {
	constructor(message: string) {
		super(message, "NETWORK_ERROR");
		this.name = "XyneNetworkError";
	}
}

export class XyneApiError extends XyneError {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message, "API_ERROR");
		this.name = "XyneApiError";
		this.status = status;
	}
}
