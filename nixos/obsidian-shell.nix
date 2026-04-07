{ lib, pkgs, inputs, config, ... }:

let
  system = pkgs.stdenv.hostPlatform.system;
  astal = inputs.astal.packages.${system};

  releaseTag = "Obsidian-shell";
  releaseAsset = "obsidian-shell";

  runtimePackages = with pkgs; [
    coreutils
    bash
    swww
    gawk
    procps
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
    sha256 = "sha256-paB3QrQHGvKTiMkV7AIut6BarkPG9UbAPKwZ5kg6eFM=";
  };

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

  home.packages = [
    obsidianShellPackage
  ];

  systemd.user.services.swww-daemon = {
    Unit = {
      Description = "swww-daemon";
      PartOf = [ "graphical-session.target" ];
    };

    Service = {
      ExecStart = "${pkgs.swww}/bin/swww-daemon";
      Restart = "on-failure";
      RestartSec = 1;
    };

    Install.WantedBy = [ "graphical-session-pre.target" ];
  };

  systemd.user.services.swww-wallpaper = {
    Unit = {
      Description = "set wallpaper";
      Requires = [ "swww-daemon.service" ];
      After = [ "swww-daemon.service" ];
      PartOf = [ "graphical-session.target" ];
    };

    Service = {
      Type = "oneshot";
      ExecStart = ''
        ${pkgs.swww}/bin/swww img \
          ${lib.escapeShellArg "${config.home.homeDirectory}/Pictures/wallpapers/current.png"} \
          --transition-type none
      '';
    };

    Install.WantedBy = [ "graphical-session.target" ];
  };
}
