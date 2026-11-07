# Assassins' Network Launcher

The launcher for [Assassins' Network](https://assassins.network), the community
multiplayer revival for Assassin's Creed Brotherhood. It signs you in with
Discord, installs and updates the multiplayer patch, and starts the game.

## Download

Get the latest build from the
[Releases page](https://github.com/ACBMP/electron-launcher/releases/latest):

- **Windows:** `acb-launcher-<version>.exe` (installer)
- **Linux:** `acb-launcher-<version>.AppImage`

### Windows SmartScreen warning

The installer isn't code-signed, so the first time you run it Windows may show
"Windows protected your PC". Click **More info**, then **Run anyway**. This
only happens on the first install: the launcher updates itself after that.

The launcher is open source and built from this repository by
[GitHub Actions](.github/workflows/release.yml), so you can check exactly what
goes into each release.

## Usage

1. Sign in with Discord, or create an account if you don't have one yet.
2. In **Settings**, choose a folder for the game. The patch is installed into an
   `acb` folder inside it.
3. Click **Install** and wait for the download to finish.
4. Pick the name to play as and click **Play**.

### Linux

The launcher runs natively, but the game itself runs under Wine or Proton, which
you set up and start yourself.

```sh
chmod +x acb-launcher-*.AppImage
./acb-launcher-*.AppImage
```

Install the patch as above. On the Play page the button reads **Prepare**: it
writes your login and settings into the game's config files. Then start
`acb/ACBMP.exe` through Wine, Proton or your launcher of choice.

Click **Prepare** again if you sign in with a different account or switch
names.

## Development

Requires Node.js 20 or newer.

```sh
npm ci
npm run build:css   # rebuild vendor/tailwind.css after changing classes
npm start
```

`npm run dist` builds installers for the current platform into `dist/`.

### Releasing

1. Bump `version` in `package.json` and commit.
2. Tag and push: `git tag v1.0.1 && git push origin v1.0.1`.
3. CI builds the installers into a draft release. Review it and click
   **Publish**. Installed launchers then pick up the update.

## Community

- Website: <https://assassins.network>
- Discord: <https://discord.gg/Th5rm6qz5u>

## License

[MIT](LICENSE). The bundled fonts keep their own licenses: Inter and JetBrains
Mono are under the SIL Open Font License 1.1, and Material Symbols under
Apache 2.0 (see `vendor/fonts/`).

Assassin's Creed is a trademark of Ubisoft. This project is not affiliated with
or endorsed by Ubisoft.
