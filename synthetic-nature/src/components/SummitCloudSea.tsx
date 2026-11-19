/**
 * SummitCloudSea.tsx — the animated summit-cloud-sea hero banner.
 *
 * Plays our custom piece (src/art/summit-cloud-sea.js — the package's scene
 * with ENZO lettered into the dawn sky) via ascii-magic-art's player at the
 * piece's own 15fps, only while on screen, first frame held for reduced motion.
 */
import { useEffect, useRef } from "react";
import { play } from "ascii-magic-art/runtime/player.js";
import * as piece from "../art/summit-cloud-sea.js";

export default function SummitCloudSea() {
  const ref = useRef<HTMLPreElement>(null);
  // play() draws the piece on the <pre> and returns stop(), which React runs on unmount
  useEffect(() => play(ref.current, piece, { look: { look: "dots" } }), []);
  return (
    <pre
      ref={ref}
      aria-label="Animated ASCII art: a snowy summit above a sea of clouds at sunrise, ENZO written in the sky, climbers on the ridge"
      style={{ fontSize: 8, lineHeight: 1, fontFamily: "Menlo, Consolas, monospace", margin: 0, overflow: "hidden" }}
    />
  );
}
