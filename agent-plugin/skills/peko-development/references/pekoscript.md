# PekoScript

A statically typed, LLVM-compiled, garbage-collected language. Generics compile
once and dispatch through witness tables rather than being monomorphized per
instantiation.

All examples here are drawn from the shipped standard library. When editing an
existing file, match its local style.

## Files and modules

A module is a file. `std::io` is `io.peko` sitting beside the package entry
`lib.peko`. A package entry can re-export its submodules:

```peko
export app;
export webview;
```

Import forms:

```peko
import std::fs;                  // module, used as fs::read_file(...)
import pekoui as ui;             // whole package under an alias: ui::app::...
import pekoui::env;              // one submodule directly
import { * } from core;          // glob the module's public items into scope
import c::core::hash as hashing; // a C module, aliased
```

`std::core` and `std::collections` are auto-imported and used bare, so `Array`
and `Map` need no import. `std::runtime`, `std::json`, and `std::xml` are
auto-imported but used through their prefix (`json::parse`). Every other module
needs an explicit import. `pekoui` is never auto-imported.

## Visibility and attributes

Attributes are bracketed and precede the declaration.

- `[public]` exports the item from its module. Default is module-private.
- `[private]` marks a class member as internal.
- `[mutates]` marks a field that gets reassigned after construction, and marks a
  method that reassigns fields. Omitting it where required is a common error.
- `[static]` declares a trait method with no receiver.
- `[serial]` derives serialization for a class.

```peko
[public] class Bridge {
    [private] handlers: Map<string, closure(string) => string>

    [mutates] fn on(method: string, handler: closure(string) => string) {
        this.handlers.set(method, handler)
    }
}
```

## Types

Primitives include `bool`, `string`, `number`, and the sized numerics `i32`,
`i64`, `f64`. `number` is the general numeric class; the sized types are used
where layout matters, such as buffers and FFI.

- `Type?` is an optional. Do not write `Option<Type>`.
- `pointer<T>` is a managed pointer.
- `&T` is a reference, produced by `index_ref` style methods.
- `closure(A, B) => R` is a callable value.
- `Array<T>` and `Map<K, V>` come from `std::collections`.

### Optionals

`None` is the empty value. Test before reading:

```peko
let content: string? = fs::read_file(path)
if !content.is_value() {
    return None
}
let text: string = content.unwrap()
```

### Casts and constants

```peko
let initial: i64 = constant<i64>(8)
let size: f64 = danger_cast<f64>(this.count)
```

`constant<T>(...)` produces a compile-time constant of a sized type.
`danger_cast<T>(...)` is an unchecked numeric conversion; it is named that way
deliberately, so reach for it only at boundaries where the range is known.

## Classes

```peko
[public] class Array<T> impl Index<number, T>, IndexRef<number, T> {
    buffer: pointer<T>
    count: i64

    /// An empty array with a small initial buffer.
    constructor() {
        this.count = constant<i64>(0)
        this.buffer = runtime::allocate<T>(danger_cast<i32>(8))
    }

    /// The number of live elements.
    [public] fn size() => number {
        return new number(danger_cast<f64>(this.count))
    }
}
```

- Fields are declared without `let`. Methods are `fn name(args) => Return`.
- `constructor()` initializes every field. `new ClassName(args)` constructs.
- `this` is the receiver.
- `class Sub from Base { ... }` inherits.
- `class Name impl TraitA, TraitB { ... }` implements traits.

## Traits and generics

```peko
[public] trait Plus<T> {
    fn plus(other: T) => T;
}

[public] trait Hash {
    fn hash() => number;
}
```

Bounds are written with `impl` inside the parameter list. A parameter can carry
several bounds:

```peko
[public] class Map<KT: impl Hash, impl Equals, VT> { ... }

[public] fn serialize<T: impl Serialize>(value: T) => JsonValue { ... }
```

Generics are erased: a generic body compiles once, and calls dispatch through the
bound's witness table. A type that fails to satisfy a bound is rejected at the
call site.

## Enums

```peko
[public] enum SortAlgorithm {
    Merge,
    Quick,
}

this.sort_algorithm = SortAlgorithm::Merge
```

Enums cross module boundaries and can be used as types in generic positions.

## Statement style

Semicolons are optional. The standard library omits them almost everywhere;
some application code uses them consistently. Match the file you are editing
rather than mixing both in one file.

String interpolation uses backticks:

```peko
let message: string = `deployed ${name} ${version}`
```

## Reserved words

Reserved words cannot be used as identifiers, including as FFI parameter names.
The ones that cause the most confusion are `fn`, `in`, and `arch`. A `let arch`
does not produce a clear error; it fails to parse and cascades into dozens of
unrelated-looking diagnostics elsewhere in the file. If a file suddenly reports
many errors after a small edit, check for a newly introduced reserved word first.

## Comments

Doc comments are `///` on an item and `//!` at the top of a file. Regular
comments are `//`.

The comment rules are enforced across `.peko`, `.c`, `.m`, and `.peko.h`:

- ASCII only. No em dashes, en dashes, arrows, smart quotes, or ellipsis
  characters. Use `-` or rewrite.
- Short declarative sentences saying what the code does.
- Never describe history. No "previously", "changed from", "now uses instead".
- Never address the reader. No second person, no "TODO: you", no asides.
- A comment describes only the code it sits on.

## Garbage collection and FFI

The GC is stop-the-world sliding mark-compact. Objects move, and a collection can
fire at any allocation.

- Do not hold a raw managed pointer across a call that can allocate or block. Get
  it again after the call instead of caching it.
- Park threads around blocking native calls, so a collection can proceed while
  they are outside managed code.
- On Android, the UI thread must park the same way during native work.

Symptoms of getting this wrong are crashes far from the cause: a null vtable
inside an unrelated dispatch, or a segfault in a lookup that has nothing to do
with the code you changed.

Writing C for a package:

- Source lives under the package's `c/` directory and is compiled per target.
- Gate per-OS code with the platform macros the toolchain defines, for example
  `__ANDROID__` and `TARGET_OS_IPHONE`.
- FFI parameters cannot be named with reserved words.
- Headers exposed to PekoScript use the `.peko.h` extension and follow the same
  comment rules.
