#!/usr/bin/env node
import { linkPiSdk } from "../scripts/link-pi-sdk.mjs";

// Resolve the current managed release before Node loads any SDK-dependent modules.
linkPiSdk({ managedOnly: true, quiet: true });
await import("./main.js");
