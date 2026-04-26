cmake_minimum_required(VERSION 3.15)
project(TinyVUDSP LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(tinyvu_dsp
    src/wasm_exports.cpp
)

target_include_directories(tinyvu_dsp PRIVATE src)

if(EMSCRIPTEN)
    set_target_properties(tinyvu_dsp PROPERTIES
        SUFFIX ".wasm"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/dist"
    )

    # WASM から JS 側に公開する関数。リーディングアンダースコアは emscripten の慣習。
    set(EXPORTED_FUNCTIONS
        "_dsp_init" "_dsp_reset"
        "_dsp_alloc_buffer" "_dsp_free_buffer" "_malloc" "_free"
        "_dsp_process_mono" "_dsp_process_stereo"
        "_dsp_get_dbfs_left" "_dsp_get_dbfs_right"
    )
    list(JOIN EXPORTED_FUNCTIONS "," EXPORTED_FUNCTIONS_STR)

    target_link_options(tinyvu_dsp PRIVATE
        "-sSTANDALONE_WASM=1"
        "-sEXPORTED_FUNCTIONS=[${EXPORTED_FUNCTIONS_STR}]"
        "-sALLOW_MEMORY_GROWTH=1"
        "-sINITIAL_MEMORY=2097152"
        "-sSTACK_SIZE=65536"
        "-sWASM=1"
        "--no-entry"
    )
    target_compile_options(tinyvu_dsp PRIVATE -O3)
endif()
