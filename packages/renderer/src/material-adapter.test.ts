import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { materialId } from "@voxel-maker/shared";
import { canonicalColor, type MaterialRecord } from "@voxel-maker/model";
import { createMaterialAdapter } from "./index.js";

const RECORD: MaterialRecord = {
  materialId: materialId(1),
  name: "accent",
  color: canonicalColor("#ff8800"),
  opacity: 1,
  roughness: 0.5,
  metallic: 0.25,
  emissive: 0,
};

describe("material adapter", () => {
  it("creates a shared material from a canonical record", () => {
    const adapter = createMaterialAdapter();
    const material = adapter.ensure(RECORD);
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(material.uuid).toBe(adapter.ensure(RECORD).uuid);
    expect(adapter.size).toBe(1);
    adapter.dispose();
  });

  it("maps color, opacity, roughness, metalness, and emissive", () => {
    const adapter = createMaterialAdapter();
    const material = adapter.ensure(RECORD);
    if (!(material instanceof THREE.MeshStandardMaterial)) {
      throw new Error("expected MeshStandardMaterial");
    }
    expect(material.color.getHexString()).toBe("ff8800");
    expect(material.roughness).toBe(0.5);
    expect(material.metalness).toBe(0.25);
    expect(material.emissive.getHex()).toBe(0x000000);
    adapter.dispose();
  });

  it("updates an existing material in place on ensure", () => {
    const adapter = createMaterialAdapter();
    const material = adapter.ensure(RECORD);
    const uuid = material.uuid;
    adapter.ensure({
      ...RECORD,
      color: canonicalColor("#00ff00"),
      opacity: 0.5,
      emissive: 0.2,
    });
    expect(material.uuid).toBe(uuid);
    if (!(material instanceof THREE.MeshStandardMaterial)) {
      throw new Error("expected MeshStandardMaterial");
    }
    expect(material.color.getHexString()).toBe("00ff00");
    expect(material.opacity).toBe(0.5);
    expect(material.transparent).toBe(true);
    expect(material.emissive.getHex()).toBeGreaterThan(0);
    adapter.dispose();
  });

  it("disposes cached materials on remove", () => {
    const adapter = createMaterialAdapter();
    const material = adapter.ensure(RECORD);
    const dispose = vi.spyOn(material, "dispose");
    adapter.remove(RECORD.materialId);
    expect(dispose).toHaveBeenCalled();
    expect(adapter.size).toBe(0);
    adapter.dispose();
  });

  it("provides a distinct error material for missing records", () => {
    const adapter = createMaterialAdapter();
    const error = adapter.errorMaterial();
    expect(error).toBe(adapter.errorMaterial());
    expect(error).not.toBe(adapter.ensure(RECORD));
    if (error instanceof THREE.MeshStandardMaterial) {
      expect(error.color.getHex()).toBe(0xff00ff);
    }
    adapter.dispose();
  });
});
