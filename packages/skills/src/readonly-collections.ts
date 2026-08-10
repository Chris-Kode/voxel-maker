/**
 * Read-only facade views (issue #108): the exported registry
 * collections are immutable accessors over module-private
 * authoritative Sets/Maps. Consumers can read the registered names and
 * capabilities but have no mutation method, so a public value can
 * never rewrite manifest validation or capability decisions. The
 * backing collections stay private to the owning module and are never
 * handed out (not even through the `forEach` callback argument).
 */

/** Read-only facade over one Set: every read of `ReadonlySet`, no write. */
export class ReadonlySetView<T> implements ReadonlySet<T> {
  private readonly backing: ReadonlySet<T>;

  constructor(backing: ReadonlySet<T>) {
    this.backing = backing;
  }

  get size(): number {
    return this.backing.size;
  }

  has(value: T): boolean {
    return this.backing.has(value);
  }

  keys(): IterableIterator<T> {
    return this.backing.keys();
  }

  values(): IterableIterator<T> {
    return this.backing.values();
  }

  entries(): IterableIterator<[T, T]> {
    return this.backing.entries();
  }

  forEach(
    callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void,
    thisArg?: unknown,
  ): void {
    // The callback receives the view, never the backing set: the
    // authoritative collection never escapes through the facade.
    this.backing.forEach((value, value2) => {
      callbackfn.call(thisArg, value, value2, this);
    });
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.backing[Symbol.iterator]();
  }

  readonly [Symbol.toStringTag]: string = "Set";
}

/** Read-only facade over one Map: every read of `ReadonlyMap`, no write. */
export class ReadonlyMapView<K, V> implements ReadonlyMap<K, V> {
  private readonly backing: ReadonlyMap<K, V>;

  constructor(backing: ReadonlyMap<K, V>) {
    this.backing = backing;
  }

  get size(): number {
    return this.backing.size;
  }

  get(key: K): V | undefined {
    return this.backing.get(key);
  }

  has(key: K): boolean {
    return this.backing.has(key);
  }

  keys(): IterableIterator<K> {
    return this.backing.keys();
  }

  values(): IterableIterator<V> {
    return this.backing.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.backing.entries();
  }

  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    // The callback receives the view, never the backing map: the
    // authoritative collection never escapes through the facade.
    this.backing.forEach((value, key) => {
      callbackfn.call(thisArg, value, key, this);
    });
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.backing[Symbol.iterator]();
  }

  readonly [Symbol.toStringTag]: string = "Map";
}
