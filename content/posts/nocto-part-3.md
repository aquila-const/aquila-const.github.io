---
title: "Adding Our Own Application"
series: "Nocto"
part: 3
date: "2023-07-20"
tags: ["yocto", "nvidia", "tegra"]
summary: "Third post for Nocto where we add our own application to run on boot after a custom splash screen."
---
## Description

This post is actually kind of brief to a little bit of a mid sized post as we really only need to understand our meta-imgui layer, how it functions during the build process with bitbake and what semi changes we need to make to the poky repo in order for it to work.

This will be utilizing systemd non sysvinit which is basically a group of System V-style init programs that include init, which is ran by the kernel as process 1 and is the subsequent parent of all other processes. We are using ubuntu so we need to use systemd. Plus systemd is the newer implementation whereas sysv is a 
bit older.

## Background 

Poky is a reference embedded integration layer which is on top of OE-Core or OpenEmbedded Core.

![yocto poky](images/poky-reference-distribution.png "Yocto Project Layer Documentation")

This consists of [¹]:

* BitBake which is a tesk exectutor, scheduler that is in the core of OpenEmbedded build system.
* meta-poky layer which is specified as poky meta data.
* meta-yocto-bsp which are a host of Yocto Project based Board Support Packages(BSP).
* OpenEmbeddedCore(OE-Core) metadata which is consisting of:
    * shared configs
    * global variable definitions
    * shared classes which define the encapsulation, inheritance of build logic
    * packaging
    * recipes which are the logical units of software and images to be built
* Documentation which consists of the Yocto Project source files used to create the set of user manuals.

## Our Application

To be very honest with you, any project that uses make or cmake can be used in here. It just needs to be tweaked a bit but if you are utilizing CMake then I suggest making sure you follow through this as best you can. If you have any suggestions for changes let me know in a PR or a comment.

### First things first

To get started the meta-imgui layer is actually quite basic:

```shell
├── conf
│   └── layer.conf
├── .gitignore
├── LICENSE
├── README.md
└── recipes-core
    ├── noctogui
    │   ├── files
    │   │   ├── noctogui-1.0.tar.gz
    │   │   ├── noctogui-init
    │   │   └── noctogui-systemd.service
    │   └── noctogui_1.0.bb
    └── psplash
        ├── files
        │   ├── psplash-bar-img.png
        │   ├── psplash-colors.h
        │   └── psplash-poky-img.png
        └── psplash_git.bbappend
```

We only have two directories and three files at the base. We can run through those now and I will try to keep it as easy to follow as possible.

### Layer.conf

The conf directory is where we store our layer configuration files. It targets the layer directory, including the recipes and any bitbake and bitbake append(for customizing already premade layers) files. We also have some attributes we can use for our layer to be compatible with certain releases e.g. dunfell, warrior and so on. [²]

### Recipes-core

In recipes-core, this consists of what is needed to build a basic linux image including commonly used dependencies. As of now the most logical place would actually be to have our project split and utilize also recipes-graphics, recipes-devtools, recipes-connectivity and so on as we should be replacing poky with our own distribution as poky is for reference or what we can learn from in regards to making our own.

In recipes-core we have noctogui, where we store our layer logic for pulling our app, building and installing it.

Next we have psplash. Psplash is used for the splash screen in core-image-sato build. Here, we have a custom colors header, the loading bar png and the logo background png. In the root we added an override file called psplash_git.bbappend which is %target_layer_file_name%.bbappend where we append a bitbake file with our overriding options.

Within our layer we need to think about what our application needs. It needs a windowing tool, bunch of graphics libraries and dependencies required by our UI app. In this case I am using ImGui which is a pretty light weight UI framework primarily used in game engines. It is quite great as we can use some graphical implementations to perform benchmarks, run memory tests and see what we can really do with our jetson nano, which really isn't much let's be honest. We can later add some opencv and really round this out.

Our main recipes-core/noctogui file is as follows:
```bash
SUMMARY = "Installer for ImGui projects."
#layer project page url
HOMEPAGE = "https://github.com/aquila-const/NoctoGui"
#layer description
DESCRIPTION = "This is a UI for Nocto repo. Built on ImGui."
#specified license
LICENSE = "MIT"
#license sanity check, md5
LIC_FILES_CHKSUM = "file://${WORKDIR}/LICENSE;md5=9768340f0372ee916245d20c0c3d67de"
DEPENDS = "gdk-pixbuf-native"

#we need x11 in order to run our GUI
DISTRO_FEATURES_append = " x11"

#There has been some issue with directly writing the ImGui application 
#to the jetson-nano-2gb image as it saves in default aarchpoky linux directory
#and is not written to the rootfs.
FILESEXTRAPATHS_prepend := "${THISDIR}/${PN}-${PV}:"
MULTIMACH_TARGET_SYS = "jetson_nano_2gb_devkit-poky-linux"
WORKDIR = "${TMPDIR}/work/${MULTIMACH_TARGET_SYS}/${PN}/${EXTENDPE}${PV}-${PR}"

#this is your release commit SHA
SRCREV = "1a008207bef7c68cdef543d551f1617c809a89e6"

#this is where you add your repo, make sure the branch name matches as well
SRC_URI = "git://github.com/aquila-const/NoctoGui.git;protocol=https;branch=main"
S = "${WORKDIR}/git"

#these are needed to compile and run our app on boot
inherit cmake pkgconfig update-alternatives systemd
#required for windowing
SYSTEMD_AUTO_ENABLE = "enable"
SYSTEMD_SERVICE_${PN} = "noctogui-systemd.service"

#The normal approach is to use += 
SRC_URI_append += " file://noctogui-systemd.service \
                    file://noctogui-init"


FILES_${PN} += "${system_unitdir}/system/noctogui.service"


PACKAGECONFIG ??= "${@bb.utils.contains('DISTRO_FEATURES', 'x11', 'x11', '', d)}"
PACKAGECONFIG[x11] = "-DWITH_X11=ON,,virtual/libx11 gtk+3"

#required by imgui and glfw to compile
DEPENDS += "libxtst libxext libxxf86vm libxi libxrandr libxrender libxcursor libxinerama libdmx libxau libxcomposite"

#fix submodule issue
do_configure_prepend() {
  cd ${WORKDIR}/git
  git submodule update --init --recursive
}
do_install_append() {
  #let's create the directories
  install -d ${D}/${sbindir}
  #app needs to be executable
  install -m 0755 ${WORKDIR}/noctogui-init ${D}/${sbindir}/noctogui-init.sh
  #let's add to the system dir to run our app on boot
  install -d ${D}/${systemd_system_unitdir}/system
  install -m 0644 ${WORKDIR}/noctogui-systemd.service ${D}/${systemd_system_unitdir}/system
  #install our app here
  install -m 0755 ${WORKDIR}/build/app/noctoui ${D}/usr/bin/noctoui

}

#when inheriting systemd

#enable systemd support
NATIVE_SYSTEMD_SUPPORT = "1"
#locates the systemd unit files when they are not found in the main recipe's package
SYSTEMD_PACKAGES = "${PN}"
#specifies the systemd service name for a package, multiple can be given
SYSTEMD_SERVICE_${PN} += "noctogui-systemd.service"
```

## Reflashing with our app

So now that we have everything set and ready to go we can rerun the flashing procedure in the previous post after we run:
```shell
bitbake core-image-sato
```

You can add the -v option at the end to get a verbose or more detailed output.

## What's next

So with that in mind we covered, so far, creating a yocto base app with using the poky repo to help speed things up a bit. Again poky is not meant for production ready software but used as a reference, something to learn from. We then found out how to do some force recovery and flash our jetson nano and get it working with a custom setup and now we have implemented our own application utilizing Dear Imgui. Next post will be adding some possible opencv and over the air updates and that will be the last post.

[¹]: https://docs.yoctoproject.org/overview-manual/yp-intro.html#the-yocto-project-layer-model
[²]: https://docs.yoctoproject.org/dev-manual/layers.html#understanding-and-creating-layers
