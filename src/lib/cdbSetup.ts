// Shared new-workspace CDB decisions (T133, D52): new workspaces
// are encrypted by default; an open CDB stays behind the explicit
// --open-cdb escape. Both CLI create paths (init, start option 1)
// decide through here so the TTY prompts, the --password-stdin pipe,
// and the abort messages stay identical.
import { listTemplates, templateDir, templatesRoot } from "./templates";

export type CdbDecision =
	| { kind: "encrypted"; password: string }
	| { kind: "open" }
	| { kind: "abort"; why: string };

export type SecretAsk = (question: string) => Promise<string | null>;

export type DecideCdbOpts = {
	passwordStdin: boolean;
	openCdb: boolean;
	isTty: boolean;
	askSecret: SecretAsk;
	readStdinPassword: () => Promise<string | null>;
	print: (line: string) => void;
};

/**
 * Resolve how the new workspace's device.cdb is created. The
 * password travels as a return value (the caller puts it in the
 * centrs child env only) — never printed, never argv.
 */
export async function decideCdb(opts: DecideCdbOpts): Promise<CdbDecision> {
	if (opts.passwordStdin && opts.openCdb) {
		return {
			kind: "abort",
			why: "cannot combine --password-stdin with --open-cdb.",
		};
	}
	if (opts.passwordStdin) {
		const pw = await opts.readStdinPassword();
		if (!pw) {
			return {
				kind: "abort",
				why: "no CDB password: --password-stdin was empty.",
			};
		}
		return { kind: "encrypted", password: pw };
	}
	if (opts.openCdb) {
		opts.print(
			"creating an open device.cdb (--open-cdb: dev escape, never the default).",
		);
		return { kind: "open" };
	}
	if (!opts.isTty) {
		return {
			kind: "abort",
			why: "no CDB password: pipe one via --password-stdin or re-run on a terminal; --open-cdb creates without encryption (dev only).",
		};
	}
	for (;;) {
		const first = await opts.askSecret("CDB password (hidden):");
		if (first === null) return { kind: "abort", why: "no password entered." };
		const second = await opts.askSecret("Repeat CDB password:");
		if (second === null) return { kind: "abort", why: "no password entered." };
		if (!first) {
			opts.print("password must not be empty.");
			continue;
		}
		if (first !== second) {
			opts.print("passwords do not match; try again.");
			continue;
		}
		return { kind: "encrypted", password: first };
	}
}

export type DecideTemplateOpts = {
	/** Flag-given template (skips the prompt); undefined prompts on a TTY. */
	given?: string;
	isTty: boolean;
	ask: (question: string) => Promise<string | null>;
	print: (line: string) => void;
	templatesRoot?: string | null;
};

function knownTemplate(name: string, override?: string | null): boolean {
	const root = override === undefined ? templatesRoot() : override;
	return templateDir(root, name) !== null;
}

/**
 * Resolve the scaffold template. A given template wins (validated);
 * on a TTY the operator picks (default minimal, re-asked on unknown);
 * off a TTY it defaults to minimal.
 */
export async function decideTemplate(
	opts: DecideTemplateOpts,
): Promise<{ ok: true; template: string } | { ok: false; why: string }> {
	if (opts.given !== undefined) {
		if (!knownTemplate(opts.given, opts.templatesRoot)) {
			return { ok: false, why: `unknown template: ${opts.given}` };
		}
		return { ok: true, template: opts.given };
	}
	if (!opts.isTty) return { ok: true, template: "minimal" };
	for (;;) {
		const answer = await opts.ask(
			"Template [minimal|network] (default: minimal):",
		);
		if (answer === null) return { ok: false, why: "no template chosen." };
		const name = answer.trim() === "" ? "minimal" : answer.trim();
		const root =
			opts.templatesRoot === undefined ? templatesRoot() : opts.templatesRoot;
		if (!knownTemplate(name, opts.templatesRoot)) {
			const have =
				listTemplates(root)
					.map((t) => t.name)
					.join(", ") || "minimal, network";
			opts.print(`unknown template: ${name} (have: ${have}).`);
			continue;
		}
		return { ok: true, template: name };
	}
}
