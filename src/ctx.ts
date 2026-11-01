// Run context: flags, the one-yes latch, the resume line.

import { confirm } from "./lib/prompt";
import { Stop } from "./lib/stop";

export type Args = {
	workspace?: string;
	yes: boolean;
	printOnly: boolean;
	router?: string;
};

export type Ctx = {
	args: Args;
	asked: boolean;
	granted: boolean;
	workspaceLabel: string;
};

export function createCtx(args: Args): Ctx {
	return {
		args,
		asked: false,
		granted: false,
		workspaceLabel: args.workspace ?? "<workspace>",
	};
}

export function resumeLine(ctx: Ctx, cmd = "code"): string {
	const parts = ["bunx", "@tikoci/routeros-muse", cmd, ctx.workspaceLabel];
	if (ctx.args.router) parts.push("--router", ctx.args.router);
	return parts.join(" ");
}

/**
 * The one yes (D13): a single consent covering every echoed
 * user-level install in this run. Asked at most once; --yes grants
 * without asking. System-level installs are never run, only printed.
 */
export async function ensureConsent(ctx: Ctx, why: string): Promise<boolean> {
	if (ctx.args.yes) {
		if (!ctx.asked) {
			console.log(
				"  one-yes granted via --yes: echoed user-level installs allowed",
			);
		}
		ctx.asked = true;
		ctx.granted = true;
		return true;
	}
	if (ctx.asked) return ctx.granted;
	ctx.asked = true;
	const answer = await confirm(
		`Allow echoed user-level installs for this run (${why})? System-level installs are never run, only printed.`,
	);
	if (answer === null) {
		throw new Stop([
			"cannot ask for install consent: no interactive terminal.",
			`Re-run with --yes, or run the printed commands by hand and resume with:`,
			`  ${resumeLine(ctx)}`,
		]);
	}
	ctx.granted = answer;
	return answer;
}
