import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { AGENT_DIR } from "../config.js";

/** Pi's non-interactive project trust, without a prompt or an implicit approval. */
export function delegateProjectTrusted(cwd: string): boolean {
  return !hasTrustRequiringProjectResources(cwd) || new ProjectTrustStore(AGENT_DIR).get(cwd) === true;
}
