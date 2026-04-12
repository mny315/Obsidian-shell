{ lib, pkgs, inputs, config, ... }:

let
  system = pkgs.stdenv.hostPlatform.system;
  astal = inputs.astal.packages.${system};

  releaseTag = "Obsidian-shell";
  releaseAsset = "obsidian-shell";

  wallpaperStateDir = "${config.home.homeDirectory}/.local/state/obsidian-shell";
  wallpaperStateFile = "${wallpaperStateDir}/last-wallpaper";
  defaultWallpaper = "${config.home.homeDirectory}/Pictures/wallpapers/default.png";

  runtimePackages = with pkgs; [
    bash
    coreutils
    gawk
    procps
    swww
    brightnessctl
    networkmanager
    wireplumber
    hypridle
    hyprlock
  ];

  gappDeps = with pkgs; [
    gobject-introspection
    gjs
    glib
    gtk4
    gtk4-layer-shell
    libadwaita
    glib-networking
    gsettings-desktop-schemas
    dconf
    shared-mime-info
    adwaita-icon-theme
    hicolor-icon-theme
    gdk-pixbuf
    pango
    harfbuzz
    cairo
    graphene
    brightnessctl
  ] ++ [
    astal.io
    astal.astal4
    astal.bluetooth
    astal.mpris
    astal.network
    astal.notifd
    astal.tray
    astal.hyprland
  ];

  src = builtins.fetchurl {
    url = "https://github.com/mny315/Obsidian-shell/releases/download/${releaseTag}/${releaseAsset}";
    sha256 = "sha256-sSs6IYPIibcJwPmsn7R2k3D+Mq9qIkpnJsed5iYNUJY=";
  };

  saveWallpaperScript = pkgs.writeShellScriptBin "obsidian-shell-set-wallpaper" ''
    set -eu

    img="''${1:-}"
    if [ -z "$img" ]; then
      echo "usage: obsidian-shell-set-wallpaper /path/to/image" >&2
      exit 1
    fi

    mkdir -p ${lib.escapeShellArg wallpaperStateDir}
    printf '%s\n' "$img" > ${lib.escapeShellArg wallpaperStateFile}

    ${pkgs.swww}/bin/swww img "$img" --transition-type none
  '';

  restoreWallpaperScript = pkgs.writeShellScript "obsidian-shell-restore-wallpaper" ''
    set -eu

    mkdir -p ${lib.escapeShellArg wallpaperStateDir}

    img=""
    if [ -f ${lib.escapeShellArg wallpaperStateFile} ]; then
      img="$(cat ${lib.escapeShellArg wallpaperStateFile})"
    fi

    if [ -z "$img" ] || [ ! -f "$img" ]; then
      img=${lib.escapeShellArg defaultWallpaper}
    fi

    if [ -f "$img" ]; then
      ${pkgs.swww}/bin/swww img "$img" --transition-type none
    fi
  '';

  obsidianShellPackage = pkgs.stdenvNoCC.mkDerivation {
    pname = "obsidian-shell";
    version = releaseTag;

    inherit src;
    dontUnpack = true;

    nativeBuildInputs = [
      pkgs.wrapGAppsHook4
      pkgs.gobject-introspection
    ];

    buildInputs = gappDeps;

    installPhase = ''
      install -Dm755 "$src" "$out/bin/obsidian-shell"
    '';

    preFixup = ''
      gappsWrapperArgs+=(
        --prefix PATH : ${lib.makeBinPath runtimePackages}
        --prefix XDG_DATA_DIRS : "${pkgs.shared-mime-info}/share"
        --prefix XDG_DATA_DIRS : "${pkgs.adwaita-icon-theme}/share"
        --prefix XDG_DATA_DIRS : "${pkgs.hicolor-icon-theme}/share"
      )
    '';

    meta = {
      mainProgram = "obsidian-shell";
      platforms = lib.platforms.linux;
    };
  };
in
{
  fonts.fontconfig.enable = true;

  home.packages = runtimePackages ++ [
    obsidianShellPackage
    saveWallpaperScript
  ];

  systemd.user.services.swww-daemon = {
    Unit = {
      Description = "swww-daemon";
      PartOf = [ "graphical-session.target" ];
      After = [ "graphical-session.target" ];
    };

    Service = {
      ExecStart = "${pkgs.swww}/bin/swww-daemon";
      Restart = "on-failure";
      RestartSec = 1;
    };

    Install.WantedBy = [ "graphical-session.target" ];
  };

  systemd.user.services.swww-wallpaper = {
    Unit = {
      Description = "Restore wallpaper with swww";
      Requires = [ "swww-daemon.service" ];
      After = [ "swww-daemon.service" ];
      PartOf = [ "graphical-session.target" ];
    };

    Service = {
      Type = "oneshot";
      ExecStart = restoreWallpaperScript;
    };

    Install.WantedBy = [ "graphical-session.target" ];
  };
}
