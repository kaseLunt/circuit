import type { Metadata } from "next";
import { SandboxComposer } from "../../components/composer/sandbox-composer";

export const metadata: Metadata = {
  title: "Composer — Circuit",
  description: "Compose a DeFi strategy on a block-pinned sandbox read set.",
};

export default function ComposerPage() {
  return <SandboxComposer />;
}
