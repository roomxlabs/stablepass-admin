"use client";

// <video> that can play Mux signed HLS streams (`....m3u8?token=...`) as well
// as plain sources (local object URLs during compose). Safari plays HLS
// natively; other browsers get hls.js, loaded lazily so it never lands in the
// bundle for photo-only sessions.
import { useEffect, useRef } from "react";
import type Hls from "hls.js";

type Props = Omit<React.VideoHTMLAttributes<HTMLVideoElement>, "src"> & { src: string };

function isHlsSrc(src: string): boolean {
  return src.split("?")[0].endsWith(".m3u8");
}

export default function HlsVideo({ src, ...rest }: Props) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    if (!isHlsSrc(src) || video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      return;
    }

    let hls: Hls | undefined;
    let cancelled = false;
    void import("hls.js").then(({ default: HlsCtor }) => {
      if (cancelled) return;
      if (!HlsCtor.isSupported()) {
        video.src = src; // last resort: let the browser try natively
        return;
      }
      hls = new HlsCtor();
      hls.loadSource(src);
      hls.attachMedia(video);
    });

    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [src]);

  return <video ref={ref} {...rest} />;
}
