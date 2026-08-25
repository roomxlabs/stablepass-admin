"use client";

// <video> that can play Mux signed HLS streams (`....m3u8?token=...`) as well
// as plain sources (local object URLs during compose). Safari plays HLS
// natively; other browsers get hls.js, loaded lazily so it never lands in the
// bundle for photo-only sessions.
//
// forwardRef: PosterScrubber (ENG-825 library re-bake) needs the underlying
// <video> for currentTime scrub/pick. Playback behaviour is unchanged.
import { forwardRef, useEffect, useRef } from "react";
import type Hls from "hls.js";

type Props = Omit<React.VideoHTMLAttributes<HTMLVideoElement>, "src"> & { src: string };

function isHlsSrc(src: string): boolean {
  return src.split("?")[0].endsWith(".m3u8");
}

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === "function") ref(value);
  else (ref as React.MutableRefObject<T | null>).current = value;
}

const HlsVideo = forwardRef<HTMLVideoElement, Props>(function HlsVideo({ src, ...rest }, ref) {
  const innerRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    assignRef(ref, innerRef.current);
    return () => assignRef(ref, null);
  }, [ref]);

  useEffect(() => {
    const video = innerRef.current;
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

  return <video ref={innerRef} {...rest} />;
});

export default HlsVideo;
