// --version (T93): read package.json, never hardcoded.
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { packageRoot } from "../lib/tools";

/** The package version, or "unknown" when the install shape hides it. */
export function readPackageVersion(pkgRoot?: string | null): string {
	const root = pkgRoot === undefined ? packageRoot() : pkgRoot;
	if (!root) return "unknown";
	try {
		const pkg = JSON.parse(
			nodeFs.readFileSync(path.join(root, "package.json"), "utf8"),
		) as Record<string, unknown>;
		return typeof pkg["version"] === "string" ? pkg["version"] : "unknown";
	} catch {
		return "unknown";
	}
}
