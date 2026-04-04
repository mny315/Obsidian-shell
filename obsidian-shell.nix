{ config, lib, pkgs, inputs, ... }:

let
  astal = inputs.astal.packages.${pkgs.system};

  binaryPath = "${config.xdg.configHome}/ags/obsidian-shell";

  runtimePackages = with pkgs; [
    bash
    coreutils
    gawk
    procps
    systemd
    brightnessctl
    networkmanager
    wireplumber
    swww
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

  wrapperPackage = pkgs.stdenvNoCC.mkDerivation {
    pname = "obsidian-shell";
    version = "1.0";
    dontUnpack = true;

    nativeBuildInputs = [
      pkgs.makeWrapper
      pkgs.wrapGAppsHook4
      pkgs.gobject-introspection
    ];

    buildInputs = runtimePackages ++ gappDeps;

    installPhase = ''
      mkdir -p "$out/bin"
      cat > "$out/bin/obsidian-shell" <<'SCRIPT'
      #!${pkgs.bash}/bin/bash
      set -euo pipefail

      target=${lib.escapeShellArg binaryPath}

      if [[ ! -e "$target" ]]; then
        echo "obsidian-shell: missing file: $target" >&2
        exit 1
      fi

      if [[ ! -x "$target" ]]; then
        echo "obsidian-shell: file exists but is not executable: $target" >&2
        exit 1
      fi

      exec "$target" "$@"
      SCRIPT
      chmod +x "$out/bin/obsidian-shell"
    '';

    preFixup = ''
      gappsWrapperArgs+=(
        --prefix PATH : ${lib.makeBinPath runtimePackages}
        --prefix XDG_DATA_DIRS : "${pkgs.shared-mime-info}/share"
        --prefix XDG_DATA_DIRS : "${pkgs.adwaita-icon-theme}/share"
        --prefix XDG_DATA_DIRS : "${pkgs.hicolor-icon-theme}/share"
      )
    '';

    meta.mainProgram = "obsidian-shell";
  };

  fontPackages = with pkgs; [
    lexend
    intel-one-mono
    material-design-icons
  ];
in
{
  fonts.fontconfig.enable = true;

  home.packages = runtimePackages ++ fontPackages ++ [ wrapperPackage ];
}
