import 'dotenv/config'
import {ethers} from "ethers";
import QuoterABI from '@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json'
import {Pool} from '@uniswap/v3-sdk/'
import {TradeType, Token, CurrencyAmount, Percent} from '@uniswap/sdk-core'
import {AlphaRouter} from '@uniswap/smart-order-router'
import IUniswapV3Pool from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
import IUniswapV3Factory
    from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json'
import {BigNumber} from '@ethersproject/bignumber';
import ERC20_abi from "./ERC20_abi.json"
import {swapConfig} from './swapConfig';

const main = async () => {

    const tokenInContractAddress = swapConfig.tokenAAddress;
    const tokenOutContractAddress = swapConfig.tokenBAddress;
    const inAmountStr = swapConfig.tokenAAmount;
    const {EVM_RPC_URL, MNEMONIC} = process.env;

    console.log("============= PART 1 --- connect to blockchain and get token balances")
    console.log("Connecting to blockchain, loading token balances...");

    const provider = new ethers.providers.JsonRpcProvider(EVM_RPC_URL);
    const networkInfo = await provider.getNetwork()
    const chainId = networkInfo.chainId;

    const signer = ethers.Wallet.fromMnemonic(MNEMONIC!).connect(provider);
    const walletAddress = signer.address;
    const contractIn = new ethers.Contract(tokenInContractAddress, ERC20_abi, signer);
    const contractOut = new ethers.Contract(tokenOutContractAddress, ERC20_abi, signer);
    const getTokenAndBalance = async function (contract: ethers.Contract) {

        let [dec, symbol, name, balance] = await Promise.all(
            [
                contract.decimals(),
                contract.symbol(),
                contract.name(),
                contract.balanceOf(walletAddress)
            ]);

        return [new Token(chainId, contract.address, dec, symbol, name), balance];

    }


    const [tokenIn, balanceTokenIn] = await getTokenAndBalance(contractIn);
    const [tokenOut, balanceTokenOut] = await getTokenAndBalance(contractOut);

    console.log(`Wallet ${walletAddress} balances:`);
    console.log(`   Input: ${tokenIn.symbol} (${tokenIn.name}): ${ethers.utils.formatUnits(balanceTokenIn, tokenIn.decimals)}`);
    console.log(`   Output: ${tokenOut.symbol} (${tokenOut.name}): ${ethers.utils.formatUnits(balanceTokenOut, tokenOut.decimals)}`);
    console.log("");

    if (Number(ethers.utils.formatUnits(balanceTokenIn, tokenIn.decimals)) < inAmountStr) {
        console.log("Insufficient balance for swap")
        return
    }

    console.log("============= PART 2 --- get Uniswap pool for pair TokenIn-TokenOut")
    console.log("Loading pool information...");

    const UNISWAP_FACTORY_ADDRESS = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
    const factoryContract = new ethers.Contract(UNISWAP_FACTORY_ADDRESS, IUniswapV3Factory.abi, provider);

    // loading pool contract
    const poolAddress = await factoryContract.getPool(
        tokenIn.address,
        tokenOut.address,
        3000);

    // there is no such pool for provided In-Out tokens.
    if (Number(poolAddress).toString() === "0")
        throw `Error: No pool ${tokenIn.symbol}-${tokenOut.symbol}`;

    const poolContract = new ethers.Contract(poolAddress, IUniswapV3Pool.abi, provider);

    const getPoolState = async function () {
        const [liquidity, slot] = await Promise.all([poolContract.liquidity(), poolContract.slot0()]);

        return {
            liquidity: liquidity,
            sqrtPriceX96: slot[0],
            tick: slot[1],
            observationIndex: slot[2],
            observationCardinality: slot[3],
            observationCardinalityNext: slot[4],
            feeProtocol: slot[5],
            unlocked: slot[6],
        }
    }

    const getPoolImmutables = async function () {
        const [factory, token0, token1, fee, tickSpacing, maxLiquidityPerTick] = await Promise.all([
            poolContract.factory(),
            poolContract.token0(),
            poolContract.token1(),
            poolContract.fee(),
            poolContract.tickSpacing(),
            poolContract.maxLiquidityPerTick(),
        ]);

        return {
            factory: factory,
            token0: token0,
            token1: token1,
            fee: fee,
            tickSpacing: tickSpacing,
            maxLiquidityPerTick: maxLiquidityPerTick,
        }
    }

    // loading immutable pool parameters and its current state (variable parameters)
    const [immutables, state] = await Promise.all([getPoolImmutables(), getPoolState()]);

    const pool = new Pool(
        tokenIn,
        tokenOut,
        immutables.fee,
        state.sqrtPriceX96.toString(),
        state.liquidity.toString(),
        state.tick
    );

    // print token prices in the pool
    console.log("Token prices in pool:");
    console.log(`   1 ${pool.token0.symbol} = ${pool.token0Price.toSignificant()} ${pool.token1.symbol}`);
    console.log(`   1 ${pool.token1.symbol} = ${pool.token1Price.toSignificant()} ${pool.token0.symbol}`);
    console.log('');


    console.log("============= PART 3 --- Giving a quote for user input")
    console.log("Loading up quote for a swap...");

    const amountIn = ethers.utils.parseUnits(String(inAmountStr), tokenIn.decimals);

    const UNISWAP_QUOTER_ADDRESS = '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6'
    const quoterContract = new ethers.Contract(UNISWAP_QUOTER_ADDRESS, QuoterABI.abi, provider);

    const quotedAmountOut = await quoterContract.callStatic.quoteExactInputSingle(
        tokenIn.address,
        tokenOut.address,
        pool.fee,
        amountIn,
        0
    );

    console.log(`   You'll get approximately ${ethers.utils.formatUnits(quotedAmountOut, tokenOut.decimals)} ${tokenOut.symbol} for ${inAmountStr} ${tokenIn.symbol}`);
    console.log('');

    console.log("============= PART 4 --- Loading a swap route")
    console.log('');
    console.log("Loading a swap route...");

    const inAmount = CurrencyAmount.fromRawAmount(tokenIn, amountIn.toString());

    const router = new AlphaRouter({chainId: tokenIn.chainId, provider: provider});
    const route = await router.route(
        inAmount,
        tokenOut,
        TradeType.EXACT_INPUT,
        {
            recipient: walletAddress,
            slippageTolerance: new Percent(5, 100),
            deadline: Math.floor(Date.now() / 1000 + 1800)
        },
        {
            maxSwapsPerPath: 1
        }
    );

    if (route == null || route.methodParameters === undefined)
        throw "No route loaded";

    console.log(`   You'll get ${route.quote.toFixed()} of ${tokenOut.symbol}`);

    // route info
    console.log(`   Gas Adjusted Quote: ${route.quoteGasAdjusted.toFixed()}`);
    console.log(`   Gas Used Quote Token: ${route.estimatedGasUsedQuoteToken.toFixed()}`);
    console.log(`   Gas Used USD: ${route.estimatedGasUsedUSD.toFixed()}`);
    console.log(`   Gas Used: ${route.estimatedGasUsed.toString()}`);
    console.log(`   Gas Price Wei: ${route.gasPriceWei}`);
    console.log('');

    console.log("============= PART 5 --- Making actual swap")
    console.log("Approving amount to spend...");
    const V3_SWAP_ROUTER_ADDRESS = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
    const approveTxUnsigned = await contractIn.populateTransaction.approve(V3_SWAP_ROUTER_ADDRESS, amountIn);
    approveTxUnsigned.chainId = chainId;
    approveTxUnsigned.gasLimit = await contractIn.estimateGas.approve(V3_SWAP_ROUTER_ADDRESS, amountIn);
    approveTxUnsigned.gasPrice = await provider.getGasPrice();
    approveTxUnsigned.nonce = await provider.getTransactionCount(walletAddress);
    const approveTxSigned = await signer.signTransaction(approveTxUnsigned);
    const submittedTx = await provider.sendTransaction(approveTxSigned);
    console.log("Waiting for approve")
    const approveReceipt = await submittedTx.wait();
    if (approveReceipt.status === 0)
        throw new Error("Approve transaction failed");

    console.log("Making a swap...");
    const value = BigNumber.from(route.methodParameters.value);

    const transaction = {
        data: route.methodParameters.calldata,
        to: V3_SWAP_ROUTER_ADDRESS,
        value: value,
        from: walletAddress,
        gasPrice: route.gasPriceWei,
        gasLimit: BigNumber.from("800000")
    };

    let tx = await signer.sendTransaction(transaction);
    const receipt = await tx.wait();

    console.log(`Swap tx https://polygonscan.com/tx/${receipt.transactionHash}`)

    if (receipt.status === 0) {
        throw new Error("Swap transaction failed");
    }

    console.log("============= Final part --- printing results")
    const [newBalanceIn, newBalanceOut] = await Promise.all([
        contractIn.balanceOf(walletAddress),
        contractOut.balanceOf(walletAddress)
    ]);

    console.log('');
    console.log('Swap completed successfully! ');
    console.log('');
    console.log('Updated balances:');
    console.log(`   ${tokenIn.symbol}: ${ethers.utils.formatUnits(newBalanceIn, tokenIn.decimals)}`);
    console.log(`   ${tokenOut.symbol}: ${ethers.utils.formatUnits(newBalanceOut, tokenOut.decimals)}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });