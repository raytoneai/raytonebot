import { useEffect, useState } from "react";

type Katex = typeof import("katex").default;

/**
 * KaTeX (and its stylesheet) load on the first formula, not with the app: it is the largest
 * single dependency of the entry chunk and most conversations never show math. Until it
 * arrives, and if it fails, the formula shows as its source — the same fallback used for a
 * formula that does not parse.
 */
let katex: Katex | undefined;
let loading: Promise<Katex> | undefined;
function loadKatex(): Promise<Katex> {
  loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([module]) => {
    katex = module.default;
    return katex;
  });
  return loading;
}

/**
 * KaTeX formula rendering with a plain-text fallback: a formula that does not
 * parse shows its source instead of throwing or rendering an error node, so a
 * typo in one expression never blanks the surrounding document.
 */
export function MathSpan({ tex, display }: { tex: string; display: boolean }) {
  const [renderer, setRenderer] = useState<Katex | undefined>(katex);
  useEffect(() => {
    if (renderer) return;
    let live = true;
    void loadKatex().then((loaded) => {
      if (live) setRenderer(() => loaded);
    }, () => undefined);
    return () => {
      live = false;
    };
  }, [renderer]);

  if (!renderer) return <code className="md-math-fallback">{tex}</code>;
  let markup: string;
  try {
    markup = renderer.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      output: "html",
    });
  } catch {
    return <code className="md-math-fallback">{tex}</code>;
  }
  return (
    <span
      className={display ? "md-math-block" : "md-math-inline"}
      // KaTeX markup is generated locally from the document's own TeX strings.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
