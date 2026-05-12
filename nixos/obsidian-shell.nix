{ lib, pkgs, inputs, config, ... }:

let
  cfg = config.programs.obsidian-shell;

  system = pkgs.stdenv.hostPlatform.system;
  astal = inputs.astal.packages.${system};

  agsPackages = if inputs ? ags then inputs.ags.packages.${system} else { };
  agsPkg =
    if agsPackages ? default then agsPackages.default
    else if agsPackages ? ags then agsPackages.ags
    else pkgs.ags;

  src =
    if inputs ? obsidian-shell then
      inputs.obsidian-shell
    else
      throw ''
        Missing flake input `obsidian-shell`.

        Add this to your flake inputs:
          obsidian-shell.url = "github:mny315/Obsidian-shell";

        Then update it with:
          nix flake lock --update-input obsidian-shell
      '';

  wallpaperStateDir = "${config.home.homeDirectory}/.local/state/obsidian-shell";
  wallpaperStateFile = "${wallpaperStateDir}/last-wallpaper";

  runtimePackages = with pkgs; [
    bash
    coreutils
    gawk
    procps
    awww
    brightnessctl
    networkmanager
    wireplumber
    hypridle
    hyprlock
  ] ++ cfg.extraRuntimePackages;

  gappDeps = with pkgs; [
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
  ] ++ [
    astal.io
    astal.astal4
    astal.bluetooth
    astal.mpris
    astal.network
    astal.tray
    astal.hyprland
  ];

  waitForAwwwScript = pkgs.writeShellScript "obsidian-shell-wait-for-awww" ''
    set -eu

    for _ in $(seq 1 200); do
      if ${pkgs.awww}/bin/awww query >/dev/null 2>&1; then
        exit 0
      fi
      sleep 0.1
    done

    echo "awww-daemon did not become ready in time" >&2
    exit 1
  '';

  saveWallpaperScript = pkgs.writeShellScriptBin "obsidian-shell-set-wallpaper" ''
    set -eu

    img="''${1:-}"
    if [ -z "$img" ]; then
      echo "usage: obsidian-shell-set-wallpaper /path/to/image" >&2
      exit 1
    fi

    if [ ! -f "$img" ]; then
      echo "wallpaper file does not exist: $img" >&2
      exit 1
    fi

    mkdir -p ${lib.escapeShellArg wallpaperStateDir}
    printf '%s\n' "$img" > ${lib.escapeShellArg wallpaperStateFile}

    ${waitForAwwwScript}
    exec ${pkgs.awww}/bin/awww img "$img" --transition-type none
  '';

  restoreWallpaperScript = pkgs.writeShellScript "obsidian-shell-restore-wallpaper" ''
    set -eu

    mkdir -p ${lib.escapeShellArg wallpaperStateDir}
    ${waitForAwwwScript}

    if ${pkgs.awww}/bin/awww restore >/dev/null 2>&1; then
      exit 0
    fi

    img=""
    if [ -f ${lib.escapeShellArg wallpaperStateFile} ]; then
      img="$(cat ${lib.escapeShellArg wallpaperStateFile})"
    fi

    if [ -n "$img" ] && [ -f "$img" ]; then
      exec ${pkgs.awww}/bin/awww img "$img" --transition-type none
    fi

    ${lib.optionalString (cfg.defaultWallpaper != null) ''
      if [ -f ${lib.escapeShellArg cfg.defaultWallpaper} ]; then
        exec ${pkgs.awww}/bin/awww img ${lib.escapeShellArg cfg.defaultWallpaper} --transition-type none
      fi
    ''}

    echo "no wallpaper available: awww restore failed, saved wallpaper missing${lib.optionalString (cfg.defaultWallpaper != null) ", default wallpaper missing"}" >&2
    exit 1
  '';

  obsidianShellPackage = pkgs.stdenvNoCC.mkDerivation {
    pname = "obsidian-shell";
    version = if src ? rev then builtins.substring 0 8 src.rev else "dirty";

    inherit src;

    nativeBuildInputs = [
      pkgs.wrapGAppsHook4
      pkgs.gobject-introspection
      agsPkg
    ];

    buildInputs = gappDeps;

    installPhase = ''
      runHook preInstall

      mkdir -p "$out/bin" "$out/libexec" "$out/share/obsidian-shell"
      cp -r ./. "$out/share/obsidian-shell"

      cd "$out/share/obsidian-shell"
      ${agsPkg}/bin/ags bundle app.tsx "$out/libexec/obsidian-shell"

      cat > "$out/bin/obsidian-shell" <<EOF2
#!${pkgs.bash}/bin/bash
set -euo pipefail
cd "$out/share/obsidian-shell"
exec "$out/libexec/obsidian-shell" "\$@"
EOF2
      chmod +x "$out/bin/obsidian-shell"

      runHook postInstall
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
  options.programs.obsidian-shell = {
    enable = lib.mkEnableOption "Obsidian shell";

    defaultWallpaper = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = "${config.home.homeDirectory}/Pictures/wallpapers/default.png";
      description = "Default wallpaper path used when no saved wallpaper exists.";
    };

    extraRuntimePackages = lib.mkOption {
      type = with lib.types; listOf package;
      default = [ ];
      description = "Additional runtime packages exposed in PATH to the shell.";
    };
  };

  config = lib.mkIf cfg.enable {
    fonts.fontconfig.enable = true;

    home.packages = [
      obsidianShellPackage
      saveWallpaperScript
    ];

    systemd.user.services.awww-daemon = {
      Unit = {
        Description = "awww-daemon";
        PartOf = [ "graphical-session.target" ];
      };

      Service = {
        ExecStart = "${pkgs.awww}/bin/awww-daemon";
        Restart = "on-failure";
        RestartSec = 1;
      };

      Install.WantedBy = [ "graphical-session.target" ];
    };

    systemd.user.services.awww-wallpaper = {
      Unit = {
        Description = "Restore wallpaper with awww";
        Requires = [ "awww-daemon.service" ];
        After = [ "graphical-session.target" "awww-daemon.service" ];
        PartOf = [ "graphical-session.target" ];
      };

      Service = {
        Type = "oneshot";
        ExecStart = restoreWallpaperScript;
      };

      Install.WantedBy = [ "graphical-session.target" ];
    };
  };
}
