export function isActiveRun(status: string | undefined): boolean {
	return status === "queued" || status === "running";
}
