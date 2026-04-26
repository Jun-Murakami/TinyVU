# Install script for directory: /mnt/d/Synching/code/JUCE/TinyVU/JUCE

# Set the install prefix
if(NOT DEFINED CMAKE_INSTALL_PREFIX)
  set(CMAKE_INSTALL_PREFIX "/usr/local")
endif()
string(REGEX REPLACE "/$" "" CMAKE_INSTALL_PREFIX "${CMAKE_INSTALL_PREFIX}")

# Set the install configuration name.
if(NOT DEFINED CMAKE_INSTALL_CONFIG_NAME)
  if(BUILD_TYPE)
    string(REGEX REPLACE "^[^A-Za-z0-9_]+" ""
           CMAKE_INSTALL_CONFIG_NAME "${BUILD_TYPE}")
  else()
    set(CMAKE_INSTALL_CONFIG_NAME "Release")
  endif()
  message(STATUS "Install configuration: \"${CMAKE_INSTALL_CONFIG_NAME}\"")
endif()

# Set the component getting installed.
if(NOT CMAKE_INSTALL_COMPONENT)
  if(COMPONENT)
    message(STATUS "Install component: \"${COMPONENT}\"")
    set(CMAKE_INSTALL_COMPONENT "${COMPONENT}")
  else()
    set(CMAKE_INSTALL_COMPONENT)
  endif()
endif()

# Install shared libraries without execute permission?
if(NOT DEFINED CMAKE_INSTALL_SO_NO_EXE)
  set(CMAKE_INSTALL_SO_NO_EXE "1")
endif()

# Is this installation the result of a crosscompile?
if(NOT DEFINED CMAKE_CROSSCOMPILING)
  set(CMAKE_CROSSCOMPILING "FALSE")
endif()

# Set default install directory permissions.
if(NOT DEFINED CMAKE_OBJDUMP)
  set(CMAKE_OBJDUMP "/usr/bin/objdump")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/mnt/d/Synching/code/JUCE/TinyVU/build-linux/JUCE/modules/cmake_install.cmake")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("/mnt/d/Synching/code/JUCE/TinyVU/build-linux/JUCE/extras/Build/cmake_install.cmake")
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/lib/cmake/JUCE-8.0.12" TYPE FILE FILES
    "/mnt/d/Synching/code/JUCE/TinyVU/build-linux/JUCE/JUCEConfigVersion.cmake"
    "/mnt/d/Synching/code/JUCE/TinyVU/build-linux/JUCE/JUCEConfig.cmake"
    "/mnt/d/Synching/code/JUCE/TinyVU/JUCE/extras/Build/CMake/JUCECheckAtomic.cmake"
    "/mnt/d/Synching/code/JUCE/TinyVU/JUCE/extras/Build/CMake/JUCEHelperTargets.cmake"
    "/mnt/d/Synching/code/JUCE/TinyVU/JUCE/extras/Build/CMake/JUCEModuleSupport.cmake"
    "/mnt/d/Synching/code/JUCE/TinyVU/JUCE/extras/Build/CMake/JUCEUtils.cmake"
    "/mnt/d/Synching/code/JUCE/TinyVU/JUCE/extras/Build/CMake/JuceLV2Defines.h.in"
    "/mnt/d/Synching/code/JUCE/TinyVU/JUCE/extras/Build/CMake/LaunchScreen.storyboard"
    "/mnt/d/Synching/code/JUCE/TinyVU/JUCE/extras/Build/CMake/PIPAudioProcessor.cpp.in"
    "/mnt/d/Synching/code/JUCE/TinyVU/JUCE/extras/Build/CMake/PIPAudioProcessorWithARA.cpp.in"
    "/mnt/d/Synching/code/JUCE/TinyVU/JUCE/extras/Build/CMake/PIPComponent.cpp.in"
    "/mnt/d/Synching/code/JUCE/TinyVU/JUCE/extras/Build/CMake/PIPConsole.cpp.in"
    "/mnt/d/Synching/code/JUCE/TinyVU/JUCE/extras/Build/CMake/RecentFilesMenuTemplate.nib"
    "/mnt/d/Synching/code/JUCE/TinyVU/JUCE/extras/Build/CMake/UnityPluginGUIScript.cs.in"
    "/mnt/d/Synching/code/JUCE/TinyVU/JUCE/extras/Build/CMake/checkBundleSigning.cmake"
    "/mnt/d/Synching/code/JUCE/TinyVU/JUCE/extras/Build/CMake/copyDir.cmake"
    "/mnt/d/Synching/code/JUCE/TinyVU/JUCE/extras/Build/CMake/juce_runtime_arch_detection.cpp"
    "/mnt/d/Synching/code/JUCE/TinyVU/JUCE/extras/Build/CMake/juce_LinuxSubprocessHelper.cpp"
    )
endif()

