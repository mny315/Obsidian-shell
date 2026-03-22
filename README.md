# Obsidian Shell

A compact **AGS v2 / GTK4 / Astal shell** for **Hyprland** and **Niri**, built around a **NixOS + Home Manager** setup.

## Screenshots

![Bar](./assets/screenshots/bar.png)
![Launcher](./assets/screenshots/launcher.png)
![Notification](./assets/screenshots/notification.png)
![Brightness](./assets/screenshots/brightness.png)
![Network](./assets/screenshots/network.png)
![Bluetooth](./assets/screenshots/bluetooth.png)
![Wallpapers](./assets/screenshots/wallpapers.png)

## Features
- multi-monitor bar
- built-in application launcher
- network and Bluetooth popovers
- MPRIS media controls
- notifications and tray integration
- brightness and volume controls
- wallpaper-related controls
- dark translucent GTK styling

## No fuzzel or rofi required
Obsidian Shell already includes its own launcher, so you do not need **fuzzel** or **rofi** just to open applications.

Example bind:

```ini
$mainMod, TAB, exec, ags request launcher toggle
```

## Blur on Hyprland
To get the intended glass look on **Hyprland**, enable blur for the `obsidian-shell` namespace:

```nix
wayland.windowManager.hyprland.settings.layerrule = [
  "match:namespace ^(obsidian-shell)$, blur 1"
  "match:namespace ^(obsidian-shell)$, blur_popups 1"
  "match:namespace ^(obsidian-shell)$, ignore_alpha 0.2"
];
```

## Installation
The repository includes a **Home Manager module** in `obsidian-shell.nix`.

Import it from your dotfiles:

```nix
imports = [ ./dotfiles/ags/obsidian-shell.nix ];
```

The module already provides the wrapper, runtime packages, and fonts.

The shell itself is expected at:

```bash
~/.config/ags/obsidian-shell
```

In a typical Home Manager setup, that file is symlinked from your dotfiles:

```nix
home.file.".config/ags/obsidian-shell".source = ./dotfiles/ags/obsidian-shell;
```

Make sure the target file is executable, then apply your config:

```bash
home-manager switch
```

After that, you can launch it with:

```bash
obsidian-shell
```

## Autostart
### Hyprland

```ini
exec-once = obsidian-shell
```

### Niri
```kdl
spawn-at-startup "obsidian-shell"
```

## Notes

- This setup is documented as a **NixOS / Home Manager** workflow.
- `obsidian-shell` in your `PATH` is a wrapper that launches `~/.config/ags/obsidian-shell`.
- If you want to change basic behavior such as brightness step, volume step, or popup auto-close timing, edit `config.ts`.
