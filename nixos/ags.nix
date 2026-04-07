{ lib, pkgs, inputs, ... }:

let
  system = pkgs.stdenv.hostPlatform.system;
  agsPkgs = inputs.ags.packages.${system};
in
{
  programs.ags = {
    enable = lib.mkDefault true;

    # Keep using the AGS package from the same flake input as the HM module.
    package = lib.mkDefault agsPkgs.default;

    # Pin core Astal packages explicitly so the runtime and libraries stay aligned.
    astal = {
      gtk3Package = lib.mkDefault agsPkgs.astal3;
      gtk4Package = lib.mkDefault agsPkgs.astal4;
      ioPackage = lib.mkDefault agsPkgs.io;
    };

    # These are added to the AGS runtime itself, not just to PATH.
    extraPackages =
      (with pkgs; [
        brightnessctl
        networkmanager
        wireplumber
        swww
        hypridle
        hyprlock
        gsettings-desktop-schemas
        glib-networking
        dconf
        shared-mime-info
        adwaita-icon-theme
        hicolor-icon-theme
      ])
      ++ [
        agsPkgs.bluetooth
        agsPkgs.hyprland
        agsPkgs.mpris
        agsPkgs.network
        agsPkgs.notifd
        agsPkgs.tray
      ]
      ++ lib.optionals (pkgs ? niri) [ pkgs.niri ];
  };

  fonts.fontconfig.enable = true;

  home.packages = with pkgs; [
    lexend
    intel-one-mono
    material-design-icons
  ];
}
