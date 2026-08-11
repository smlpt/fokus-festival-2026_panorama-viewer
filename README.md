# Fokus Festival 2026 Panorama Viewer

This repository hosts the website code for my Panorama Viewer for the Fokus Festival 2026, happening in late August 2026 at Rabryka in Görlitz.

It serves pairs of spherical panorama textures, a base image and a depth map, which are combined to create a parallax effect via the fragment shader. It supports both mouse-based movement as well as immersive viewing via a phone's orientation sensors.

There are different locations on the Rabryka grounds, each containing several panorama alternative versions. The locations are encoded as HTML hashes. A landing page allows to select locations, and during the festival QR codes with links to the location hashes are distributed in the area.

The website is [hosted on Github Pages](https://smlpt.github.io/fokus-festival-2026_panorama-viewer/).


### Technical info & AI disclaimer

The panoramas were captured with my Pixel 8a and a google camera mod that still allows creating spherical panoramas.

Parts of the panoramas were generated with a generative image model. For that I used the ComfyUI framework, running locally on my GPU, to edit the panorama photos with the [Flux2 Klein 9B model](https://huggingface.co/black-forest-labs/FLUX.2-klein-9B), then upscaled them with the [SeedVR2 model](https://github.com/ByteDance-Seed/SeedVR). Afterwards I merged the two versions with Affinity Photo to preserve the real photo where possible.

The depth map was generated in ComfyUI with the [DAP model](https://github.com/Insta360-Research-Team/DAP), using the composite panorama as input.

Part of the code scaffold was generated with Gemma 4 26B, running locally on my GPU. A few shader code bugs were fixed with Claude.