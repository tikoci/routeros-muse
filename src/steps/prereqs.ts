// Step 1: prereq check. Bun (present by definition), git, OS/arch.
// QEMU + KVM are checked but optional: their absence degrades to
// "real-box only", never to failure.

import * as nodeFs from "node:fs";
import { have } from "../lib/run";

export type OsName = "mac" | "windows" | "linux" | string;

export function osName(): OsName {
	if (process.platform === "darwin") return "mac";
	if (process.platform === "win32") return "windows";
	if (process.platform === "linux") return "linux";
	return process.platform;
}

export type Prereqs = {
	bun: string;
	git: string | null;
	os: OsName;
	arch: string;
	qemu: boolean;
	kvm: boolean | null; // null where the concept does not apply (mac/windows)
};

export async function checkPrereqs(): Promise<Prereqs> {
	const git = have("git") ? "present" : null;
	const qemu = have("qemu-system-x86_64") || have("qemu-system-aarch64");
	let kvm: boolean | null = null;
	if (process.platform === "linux") {
		kvm = nodeFs.existsSync("/dev/kvm");
	}
	return { bun: Bun.version, git, os: osName(), arch: process.arch, qemu, kvm };
}

export function printPrereqs(p: Prereqs): void {
	console.log(`  bun: ${p.bun} (present by definition)`);
	console.log(`  git: ${p.git ?? "MISSING (only git homes need it)"}`);
	console.log(`  os/arch: ${p.os}/${p.arch}`);
	console.log(
		`  qemu: ${p.qemu ? "present" : "absent (optional; twin work needs it)"}`,
	);
	if (p.kvm === null) {
		console.log(`  kvm: n/a on ${p.os}`);
	} else {
		console.log(
			`  kvm: ${p.kvm ? "/dev/kvm present" : "absent (optional; twin work needs it)"}`,
		);
	}
}
