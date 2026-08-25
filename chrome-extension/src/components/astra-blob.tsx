import { JellyBlobMascot } from "feral-blob";

type AstraBlobProps = {
  isComposing: boolean;
};

export function AstraBlob({ isComposing }: AstraBlobProps) {
  return (
    <div aria-hidden className="astra-blob pointer-events-none">
      <JellyBlobMascot
        className="size-28"
        gaze={isComposing ? { intensity: 0.7, x: 12, y: 8 } : { x: 0, y: 0 }}
        mood={isComposing ? "happy" : "neutral"}
        nod={isComposing}
      />
    </div>
  );
}
