# Build resources

`electron-builder` looks here for assets it bakes into the packaged app
(`buildResources: build` in [../electron-builder.yml](../electron-builder.yml)).

## App icon

Drop a single square PNG here:

```
build/icon.png     1024x1024
```

That's all that's needed. electron-builder converts it to the platform formats
at build time — `.ico` for Windows, `.icns` for macOS — so there's no need to
create either by hand. macOS conversion happens on the macOS runner using
Apple's own tooling.

Without this file the app ships with the default Electron icon, and the build
log says `default Electron icon is used`.

Notes:

- Transparency is fine and normal.
- macOS does not round the corners for you; bake that into the artwork if you
  want it.
- Check it still reads at 32x32 — that's the size students actually see in the
  taskbar or Dock.
