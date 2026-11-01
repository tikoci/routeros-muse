// Stop: an expected halt (blocked step, declined consent, invalid
// workspace). Steps throw it; the entrypoint prints it plus the
// resume line and exits 2. Anything else is a bug: exit 1.

export class Stop extends Error {
	lines: string[];
	constructor(lines: string[]) {
		super(lines.join("\n"));
		this.lines = lines;
	}
}
