import { useContext } from "react";
import { XyneContext } from "../components/xyne-provider";
import type { XyneClient } from "../core/xyne-client";

export function useXyneClient(): XyneClient {
	const client = useContext(XyneContext);
	if (client === null) {
		throw new Error("useXyneClient must be used within a <XyneProvider>");
	}
	return client;
}
