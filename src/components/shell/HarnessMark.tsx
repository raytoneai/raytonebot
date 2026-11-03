import { useId } from 'react';
import type { AgentHarnessId } from '../../pi/harnessCatalog';
import { harnessMarkSVG } from '../../avatars/harnessArtwork';

/** Original publisher marks, also used on Bot sunglasses, mounted on a shaded enamel tile. */
export function HarnessMark({ harness, size = 12 }: { harness: AgentHarnessId; size?: number }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return <span className="harness-mark" data-harness={harness} aria-hidden="true" style={{ width: size, height: size }}
    dangerouslySetInnerHTML={{ __html: harnessMarkSVG(harness, `harness-${id}`) }} />;
}
