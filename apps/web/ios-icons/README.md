# Theme-aware iOS app icons

These folders hold one icon set per app theme (matching `THEMES` in
`apps/web/src/lib/theme.ts`). They let the **native iOS app** switch its
home-screen icon to match the theme the user picks in the app.

> **Why pre-rendered?** iOS does not allow generating an app icon at runtime.
> You can only switch between a fixed set of icons declared up front in
> `Info.plist` (`CFBundleAlternateIcons`), via `UIApplication.setAlternateIconName`.
> So we bake one icon per theme here and switch between them.
>
> This applies to the **native (Capacitor) iOS app**. A **PWA** added to the
> home screen has its icon cached by the OS at install time and *cannot* be
> changed at runtime at all — there's no alternate-icon API for PWAs. The app
> still updates the PWA `theme-color` (Android chrome/splash tint) and the
> `apple-touch-icon` live, so a *fresh* "Add to Home Screen" captures the
> current theme.

Each folder (`default/`, `oled/`, `sunset/`, …) contains:

- `AppIcon-60@2x.png` (120×120) — iPhone
- `AppIcon-60@3x.png` (180×180) — iPhone
- `AppIcon-76.png` (76×76) — iPad
- `AppIcon-76@2x.png` (152×152) — iPad

## Wiring it up (one-time, in Xcode)

1. **Install the plugin** (JS side already calls it; it's a no-op until present):

   ```sh
   pnpm add @capacitor-community/app-icon
   npx cap sync ios
   ```

2. **Add the icon files** to the iOS target. In Xcode, drag each theme's PNGs
   into the app target (NOT the asset catalog — alternate icons must be loose
   files in the bundle, or use an asset catalog configured for alternate
   icons). Name them per theme, e.g. `oled-AppIcon-60@2x.png`, or keep them in
   per-theme groups; what matters is the `CFBundleIconFiles` names below match.

3. **Declare them in `Info.plist`** under `CFBundleIcons` →
   `CFBundleAlternateIcons`. The **key for each alternate must equal the theme
   id** (`oled`, `sunset`, `sunset-oled`, `forest`, …) because the app calls
   `AppIcon.change({ name: themeId })`. `default` is the primary icon
   (`CFBundlePrimaryIcon`) and is selected with `name: null`. Example:

   ```xml
   <key>CFBundleIcons</key>
   <dict>
     <key>CFBundlePrimaryIcon</key>
     <dict>
       <key>CFBundleIconFiles</key>
       <array><string>AppIcon-60</string></array>
     </dict>
     <key>CFBundleAlternateIcons</key>
     <dict>
       <key>oled</key>
       <dict>
         <key>CFBundleIconFiles</key>
         <array><string>oled-AppIcon-60</string></array>
         <key>UIPrerenderedIcon</key><false/>
       </dict>
       <key>sunset</key>
       <dict>
         <key>CFBundleIconFiles</key>
         <array><string>sunset-AppIcon-60</string></array>
       </dict>
       <!-- …one entry per theme id… -->
     </dict>
   </dict>
   ```

   (iOS picks `@2x`/`@3x` automatically from the base name, so list the base
   name without the scale suffix.)

Once that's in place, choosing a theme in Settings → Appearance will switch the
iOS home-screen icon to match (the app calls `applyNativeTheme()` →
`AppIcon.change()`), and tint the status bar.

## Regenerating

If you add/rename a theme or tweak accent colors, update the `THEMES` list in
`scripts/generate-ios-icons.mjs` to match `theme.ts`, then:

```sh
pnpm add -D sharp -w   # if not already installed
node scripts/generate-ios-icons.mjs
```
