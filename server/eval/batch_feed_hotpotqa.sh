#!/bin/bash

split_dir="datasets/HotpotQA/splits"
output_dir="datasets/HotpotQA/splits"
log_dir="logs"
mkdir -p "$log_dir"

# All chunks (adjust as per your files)
# parts=(ua ub uc ud ue uf ug uh ui uj uk ul um un uo up uq ur us ut uu uv uw ux uy uz
# va vb vc vd ve vf vg vh vi vj vk vl vm vn vo vp vq vr vs vt vu vv vw vx vy vz
# wa wb wc wd we wf wg wh wi wj wk wl wm wn wo wp wq wr ws wt wu wv ww wx wy wz
# xa xb xc xd xe xf xg xh xi xj xk xl xm xn xo xp xq xr xs xt xu xv xw xx xy xz
# ya yb yc yd ye yf yg yh yi yj yk yl ym yn yo yp yq yr ys yt yu yv yw yx yy yz
# za zb zc zd ze zf zg zh zi zj zk zl zm zn zo zp zq zr zs zt zu zv zw zx zy zz)
# # Number of chunks per batch
parts=(na nb nc nd ne nf ng nh ni nj nk nl nm nn no np nq nr ns nt nu nv nw nx ny nz
oa ob oc od oe of og oh oi oj ok ol om on oo op oq or os ot ou ov ow ox oy oz
pa pb pc pd pe pf pg ph pi pj pk pl pm pn po pp pq pr ps pt pu pv pw px py pz
qa qb qc qd qe qf qg qh qi qj qk ql qm qn qo qp qq qr qs qt qu qv qw qx qy qz
ra rb rc rd re rf rg rh ri rj rk rl rm rn ro rp rq rr rs rt ru rv rw rx ry rz
sa sb sc sd se sf sg sh si sj sk sl sm sn so sp sq sr ss st su sv sw sx sy sz
ta tb tc td te tf tg th ti tj tk tl tm tn to tp tq tr ts tt tu tv tw tx ty tz
ua ub uc ud ue uf ug uh ui uj uk ul um un uo up uq ur us ut uu uv uw ux uy uz
va vb vc vd ve vf vg vh vi vj vk vl vm vn vo vp vq vr vs vt vu vv vw vx vy vz
wa wb wc wd we wf wg wh wi wj wk wl wm wn wo wp wq wr ws wt wu wv ww wx wy wz
xa xb xc xd xe xf xg xh xi xj xk xl xm xn xo xp xq xr xs xt xu xv xw xx xy xz
ya yb yc yd ye yf yg yh yi yj yk yl ym yn yo yp yq yr ys yt yu yv yw yx yy yz
za zb zc zd ze zf zg zh zi zj zk zl zm zn zo zp zq zr zs zt zu zv zw zx zy zz)
batch_size=10

# Loop over parts in batches of 10
for ((i = 0; i < ${#parts[@]}; i += batch_size)); do
  batch=("${parts[@]:i:batch_size}")
  echo "🌀 Starting batch: ${batch[*]}"
  start_time=$(date +%s)

  for part in "${batch[@]}"; do
    input="$split_dir/corpus_part_$part.jsonl"
    output="$output_dir/processed_part_$part.json"
    log_file="$log_dir/feed_log_$part.txt"

    echo "🔄 Processing: $input ..."
    bun run processDataForVespa.ts --corpus "$input" --output "$output"

    echo "📤 Feeding to Vespa: $output ..."
    if vespa feed -t http://localhost:8080 "$output" >"$log_file" 2>&1; then
      echo "✅ Success: $part"
    else
      echo "❌ Failed: $part (check $log_file)"
    fi
    echo ""
  done

  end_time=$(date +%s)
  elapsed=$((end_time - start_time))
  echo "⏱️ Batch ${i}-${i+batch_size-1} done in ${elapsed}s"
  echo "-------------------------------------------"
done

echo "🚀 All batches processed and fed to Vespa!"
