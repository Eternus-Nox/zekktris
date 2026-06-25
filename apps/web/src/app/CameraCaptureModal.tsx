import { useEffect, useRef, useState } from 'react';
import { Camera, X } from '../lib/icons';

/**
 * Desktop camera capture: opens a live getUserMedia preview and lets the user
 * snap a still, handed back as a JPEG File (the composer feeds it into the same
 * attachment path as a picked file). On mobile we use a `<input capture>`
 * instead (the OS camera UI), so this modal is the desktop/no-capture path.
 *
 * Self-contained fixed overlay (not portaled into a popover — see the
 * click-outside-trap note in repo memory). Stops all tracks on close/unmount.
 */
export function CameraCaptureModal({
  onCapture,
  onClose,
}: {
  onCapture: (file: File) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setReady(true);
      } catch {
        if (!cancelled) setError('Could not access the camera. Check permissions.');
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  const snap = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        onCapture(new File([blob], `photo-${blob.size}.jpg`, { type: 'image/jpeg' }));
        onClose();
      },
      'image/jpeg',
      0.9,
    );
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-lg rounded-xl bg-bg-1 border border-line overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 h-12 border-b border-line/60">
          <span className="text-sm font-semibold text-ink-1">Take a photo</span>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 -mr-1 flex items-center justify-center rounded-md text-ink-2 hover:text-ink-1 hover:bg-bg-3"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="bg-black aspect-video flex items-center justify-center">
          {error ? (
            <p className="text-sm text-ink-3 px-6 text-center">{error}</p>
          ) : (
            // Mirror the preview so it reads like a selfie cam.
            <video ref={videoRef} playsInline muted className="w-full h-full object-cover -scale-x-100" />
          )}
        </div>
        <div className="flex items-center justify-center gap-3 p-3">
          <button
            type="button"
            onClick={snap}
            disabled={!ready || !!error}
            className="inline-flex items-center gap-2 px-4 h-10 rounded-md bg-accent text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Camera size={18} /> Capture
          </button>
        </div>
      </div>
    </div>
  );
}
