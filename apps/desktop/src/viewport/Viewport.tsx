import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { DesktopComposition } from "../composition.js";

/**
 * Three.js viewport (plan S6.1/S6.3): owns the WebGL renderer, camera, and
 * animation loop, and renders the composition's projected scene. Camera
 * control is deliberately minimal here — the orbit/pick/view workflows are
 * desktop tickets #16+.
 */
export function Viewport({
  composition,
}: {
  readonly composition: DesktopComposition;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(
      50,
      host.clientWidth / Math.max(host.clientHeight, 1),
      0.1,
      100000,
    );
    camera.position.set(24, 20, 24);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 4, 0);
    controls.update();

    const resizeObserver = new ResizeObserver(() => {
      const width = host.clientWidth;
      const height = Math.max(host.clientHeight, 1);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    });
    resizeObserver.observe(host);

    let frame = 0;
    const animate = (): void => {
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(composition.renderer.scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, [composition]);

  return (
    <div
      ref={hostRef}
      className="viewport"
      role="img"
      aria-label="3D viewport showing the open voxel document"
    />
  );
}
