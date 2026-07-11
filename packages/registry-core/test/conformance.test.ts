/**
 * The core conformance suite against the in-memory adapters.
 *
 * One suite definition (`conformanceSuite`) runs here against the in-memory
 * ports and again in apps/registry against the real D1/R2/DO adapters, so a
 * divergence between the two adapter sets fails CI. The in-memory adapters
 * additionally honour a custom multipart part size, which lets the suite
 * exercise blob reassembly across R2 part boundaries without a 5 MiB upload.
 */

import { conformanceSuite } from "./conformance-suite.js";
import { createTestRegistry } from "./memory.js";

conformanceSuite(createTestRegistry, { customPartSize: true });
