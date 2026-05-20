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
    if inputs ? obsidian-shell then inputs.obsidian-shell
    else throw ''
      Missing flake input `obsidian-shell`.
      Add this to your flake inputs:
        obsidian-shell.url = "github:mny315/Obsidian-shell";
      Then update it with:
        nix flake lock --update-input obsidian-shell
    '';

  cleanSrc = lib.cleanSourceWith {
    inherit src;
    filter = path: type:
      let
        name = baseNameOf path;
      in
        !(name == ".git"
          || name == ".direnv"
          || name == ".devenv"
          || name == "node_modules"
          || name == "result"
          || name == "dist"
          || name == "build"
          || name == "tmp"
          || name == ".tmp"
          || lib.hasSuffix ".log" name
          || lib.hasSuffix ".tmp" name
          || lib.hasSuffix ".bak" name
          || lib.hasSuffix "~" name);
  };

  wallpaperStateDir = "${config.home.homeDirectory}/.local/state/obsidian-shell";
  wallpaperStateFile = "${wallpaperStateDir}/last-wallpaper";
  wallpaperWidgetStateDir = "${config.home.homeDirectory}/.local/state/ags";
  wallpaperWidgetSettingsFile = "${wallpaperWidgetStateDir}/wallpaper-widget.json";

  runtimePackages = with pkgs; [
    bash
    coreutils
    gawk
    gnugrep
    gnused
    procps
    systemd
    awww
    brightnessctl
    ddcutil
    gtk3
    networkmanager
    pipewire
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
    astal.hyprland
    astal.mpris
    astal.network
    astal.notifd
    astal.tray
  ];

  runtimePath = lib.makeBinPath runtimePackages;

  waitForAwwwScript = pkgs.writeShellScript "obsidian-shell-wait-for-awww" ''
    set -eu

    for _ in $(${pkgs.coreutils}/bin/seq 1 300); do
      output="$(${pkgs.awww}/bin/awww query 2>/dev/null || true)"
      if [ -n "$output" ]; then
        exit 0
      fi
      ${pkgs.coreutils}/bin/sleep 0.1
    done

    ${pkgs.coreutils}/bin/printf '%s\n' "awww-daemon did not expose any outputs in time" >&2
    exit 1
  '';

  waitForAudioScript = pkgs.writeShellScript "obsidian-shell-wait-for-audio" ''
    set -eu

    debug_log() {
      if [ "''${OBSIDIAN_SHELL_DEBUG_WRAPPER:-0}" = "1" ]; then
        ${pkgs.coreutils}/bin/printf '%s\n' "$*" >&2
      fi
    }

    for _ in $(${pkgs.coreutils}/bin/seq 1 100); do
      if ${pkgs.pipewire}/bin/pw-cli info 0 >/dev/null 2>&1 \
        && ${pkgs.wireplumber}/bin/wpctl status >/dev/null 2>&1; then
        debug_log "PipeWire/WirePlumber are ready"
        exit 0
      fi
      ${pkgs.coreutils}/bin/sleep 0.1
    done

    debug_log "PipeWire/WirePlumber did not become ready in time; starting obsidian-shell anyway"
    exit 0
  '';

  saveWallpaperScript = pkgs.writeShellScriptBin "obsidian-shell-set-wallpaper" ''
    set -eu

    img="''${1:-}"
    if [ -z "$img" ]; then
      ${pkgs.coreutils}/bin/printf '%s\n' "usage: obsidian-shell-set-wallpaper /path/to/image" >&2
      exit 2
    fi

    if [ ! -f "$img" ]; then
      ${pkgs.coreutils}/bin/printf 'wallpaper does not exist: %s\n' "$img" >&2
      exit 1
    fi

    img="$(${pkgs.coreutils}/bin/readlink -f -- "$img")"
    ${pkgs.coreutils}/bin/mkdir -p ${lib.escapeShellArg wallpaperStateDir} ${lib.escapeShellArg wallpaperWidgetStateDir}
    ${pkgs.coreutils}/bin/printf '%s\n' "$img" > ${lib.escapeShellArg wallpaperStateFile}

    tmp=${lib.escapeShellArg "${wallpaperWidgetSettingsFile}.tmp"}.$$
    if [ -f ${lib.escapeShellArg wallpaperWidgetSettingsFile} ]; then
      if ${pkgs.jq}/bin/jq --arg img "$img" '. + { currentWallpaper: $img }' ${lib.escapeShellArg wallpaperWidgetSettingsFile} > "$tmp"; then
        ${pkgs.coreutils}/bin/mv -f -- "$tmp" ${lib.escapeShellArg wallpaperWidgetSettingsFile}
      else
        ${pkgs.coreutils}/bin/rm -f -- "$tmp"
        ${pkgs.jq}/bin/jq -n --arg img "$img" '{ currentWallpaper: $img }' > ${lib.escapeShellArg wallpaperWidgetSettingsFile}
      fi
    else
      ${pkgs.jq}/bin/jq -n --arg img "$img" '{ currentWallpaper: $img }' > ${lib.escapeShellArg wallpaperWidgetSettingsFile}
    fi

    ${waitForAwwwScript}
    exec ${pkgs.awww}/bin/awww img "$img" --transition-type none --transition-step 255
  '';

  restoreWallpaperScript = pkgs.writeShellScript "obsidian-shell-restore-wallpaper" ''
    set -eu

    ${pkgs.coreutils}/bin/mkdir -p ${lib.escapeShellArg wallpaperStateDir} ${lib.escapeShellArg wallpaperWidgetStateDir}
    ${waitForAwwwScript}

    img=""

    if [ -f ${lib.escapeShellArg wallpaperWidgetSettingsFile} ]; then
      img="$(${pkgs.jq}/bin/jq -r '.currentWallpaper // empty' ${lib.escapeShellArg wallpaperWidgetSettingsFile} 2>/dev/null || true)"
    fi

    if [ -z "$img" ] && [ -f ${lib.escapeShellArg wallpaperStateFile} ]; then
      IFS= read -r img < ${lib.escapeShellArg wallpaperStateFile} || img=""
    fi

    if [ -n "$img" ] && [ -f "$img" ]; then
      img="$(${pkgs.coreutils}/bin/readlink -f -- "$img")"
      ${pkgs.coreutils}/bin/printf '%s\n' "$img" > ${lib.escapeShellArg wallpaperStateFile}
      exec ${pkgs.awww}/bin/awww img "$img" --transition-type none --transition-step 255
    fi

    ${lib.optionalString (cfg.defaultWallpaper != null) ''
      if [ -f ${lib.escapeShellArg cfg.defaultWallpaper} ]; then
        img="$(${pkgs.coreutils}/bin/readlink -f -- ${lib.escapeShellArg cfg.defaultWallpaper})"
        ${pkgs.coreutils}/bin/printf '%s\n' "$img" > ${lib.escapeShellArg wallpaperStateFile}
        ${pkgs.jq}/bin/jq -n --arg img "$img" '{ currentWallpaper: $img }' > ${lib.escapeShellArg wallpaperWidgetSettingsFile}
        exec ${pkgs.awww}/bin/awww img "$img" --transition-type none --transition-step 255
      fi
    ''}

    ${pkgs.coreutils}/bin/printf '%s\n' "No saved wallpaper and no valid default wallpaper configured" >&2
    exit 1
  '';

  obsidianShellPackage = pkgs.stdenvNoCC.mkDerivation {
    pname = "obsidian-shell";
    version = if src ? rev then builtins.substring 0 8 src.rev else "unstable";
    src = cleanSrc;

    nativeBuildInputs = [
      pkgs.makeWrapper
      pkgs.wrapGAppsHook4
      pkgs.gobject-introspection
      agsPkg
    ];

    buildInputs = gappDeps;

    dontWrapGApps = true;

    installPhase = ''
      runHook preInstall

      mkdir -p "$out/bin" "$out/libexec" "$out/share/obsidian-shell"
      cp -R --no-preserve=mode,ownership ./. "$out/share/obsidian-shell"
      chmod -R u+w "$out/share/obsidian-shell"

      cd "$out/share/obsidian-shell"
      ${agsPkg}/bin/ags bundle app.tsx "$out/libexec/obsidian-shell-real"
      chmod +x "$out/libexec/obsidian-shell-real"

      cat > "$out/libexec/obsidian-shell-launcher" <<'EOF2'
#!${pkgs.bash}/bin/bash
set -euo pipefail

real="@out@/libexec/obsidian-shell-real"
root="@out@/share/obsidian-shell"

unset PIPEWIRE_REMOTE
unset PIPEWIRE_RUNTIME_DIR
unset PULSE_SERVER

if [ "''${OBSIDIAN_SHELL_WAIT_AUDIO:-1}" != "0" ]; then
  ${waitForAudioScript} || true
fi

cd "$root"
exec "$real" "$@"
EOF2
      substituteInPlace "$out/libexec/obsidian-shell-launcher" --subst-var-by out "$out"
      chmod +x "$out/libexec/obsidian-shell-launcher"

      runHook postInstall
    '';

    preFixup = ''
      gappsWrapperArgs+=(
        --prefix PATH : ${lib.escapeShellArg runtimePath}
        --set OBSIDIAN_SHELL_DDCUTIL ${lib.escapeShellArg "${pkgs.ddcutil}/bin/ddcutil"}
        --set OBSIDIAN_SHELL_ROOT "$out/share/obsidian-shell"
        --prefix XDG_DATA_DIRS : ${lib.escapeShellArg "${pkgs.shared-mime-info}/share"}
        --prefix XDG_DATA_DIRS : ${lib.escapeShellArg "${pkgs.adwaita-icon-theme}/share"}
        --prefix XDG_DATA_DIRS : ${lib.escapeShellArg "${pkgs.hicolor-icon-theme}/share"}
      )
    '';

    postFixup = ''
      makeWrapper "$out/libexec/obsidian-shell-launcher" "$out/bin/obsidian-shell" \
        "''${gappsWrapperArgs[@]}"
    '';

    passthru = {
      inherit runtimePackages gappDeps;
      setWallpaper = saveWallpaperScript;
      restoreWallpaper = restoreWallpaperScript;
    };

    meta = with lib; {
      description = "AGS/Astal desktop shell wrapper for Obsidian-shell";
      mainProgram = "obsidian-shell";
      platforms = platforms.linux;
    };
  };

in
{
  options.programs.obsidian-shell = {
    enable = lib.mkEnableOption "Obsidian shell";

    package = lib.mkOption {
      type = lib.types.package;
      default = obsidianShellPackage;
      readOnly = true;
      description = "Built Obsidian shell package.";
    };

    defaultWallpaper = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = "${config.home.homeDirectory}/Pictures/wallpapers/default.png";
      description = "Wallpaper restored when no previously selected wallpaper exists.";
    };

    extraRuntimePackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      description = "Additional packages exposed on PATH for shell widgets and scripts.";
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
        Description = "awww wallpaper daemon";
        PartOf = [ "graphical-session.target" ];
        After = [ "graphical-session.target" ];
      };

      Service = {
        ExecStart = "${pkgs.awww}/bin/awww-daemon --no-cache --quiet";
        Restart = "on-failure";
        RestartSec = 1;
      };

      Install.WantedBy = [ "graphical-session.target" ];
    };

    systemd.user.services.awww-wallpaper = {
      Unit = {
        Description = "Restore Obsidian shell wallpaper";
        Requires = [ "awww-daemon.service" ];
        After = [ "graphical-session.target" "awww-daemon.service" ];
        PartOf = [ "graphical-session.target" ];
      };

      Service = {
        Type = "oneshot";
        ExecStart = "${restoreWallpaperScript}";
      };

      Install.WantedBy = [ "graphical-session.target" ];
    };
  };
}
